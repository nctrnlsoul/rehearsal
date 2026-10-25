/**
 * What the live run page draws, from one poll of GET /api/runs/[runId]. Pure,
 * so every state is tested without a browser.
 *
 * A call is joined to a delivery only where the pairing is exact:
 *   - a card order and the store's order with the same capture id;
 *   - a resend and the second delivery of the event id it resent.
 * The store's per-event report carries no capture id, so nothing else can be
 * tied to a call without guessing, and this never guesses. Every delivery
 * still appears in the ledger, by event id.
 *
 * Deliveries are seen when the worker polls the store (every 5 s), so a
 * latency is an upper bound and is labeled "within".
 */

export type LiveRunRow = {
  readonly id: string;
  readonly kind: string;
  readonly plan_source: string;
  readonly plan_id: string;
  readonly scenario_sha256: string | null;
  readonly status: string;
  readonly state: unknown;
  readonly halt_reason: string | null;
  readonly created_at: string;
  readonly started_at: string | null;
  readonly heartbeat_at: string | null;
  readonly finished_at: string | null;
};

export type LiveEvent = {
  readonly seq: number;
  readonly at: string;
  readonly kind: string;
  readonly step_id: string | null;
  readonly data: Record<string, unknown>;
};

export type LiveRead = { readonly run: LiveRunRow; readonly events: readonly LiveEvent[]; readonly now: string };

export type Phase = "queued" | "running" | "waiting" | "complete" | "halted" | "abandoned" | "failed";

export type CallStatus = "succeeded" | "failed" | "unknown" | "in-flight" | "never-confirmed";

export type LiveCall = {
  readonly key: string;
  readonly step: string;
  readonly kind: string;
  readonly t: number;
  readonly at: string;
  readonly status: CallStatus;
  readonly detail: string;
  readonly ids: Readonly<Record<string, string>>;
};

export type LiveDelivery = {
  readonly key: string;
  readonly pair: string;
  readonly t: number;
  readonly at: string;
  readonly title: string;
  readonly facts: ReadonlyArray<readonly [string, string]>;
};

/** One call-delivery pair. arrivedT null: still waiting, or the wait ended without it. */
export type LivePair = {
  readonly callKey: string;
  readonly deliveryKey: string;
  readonly what: string;
  readonly callT: number;
  readonly arrivedT: number | null;
};

export type LedgerRow = {
  readonly eventId: string;
  readonly eventType: string | null;
  readonly deliveries: number;
  readonly fulfilled: number;
  readonly duplicatesIgnored: number;
  readonly refused: number;
  readonly certHosts: readonly string[];
  readonly firstSeenT: number;
};

/** The finder's verdict, from the store's own records (R-012). */
export type LiveFinding = {
  readonly classId: string;
  readonly verdict: "bug" | "ok" | "inconclusive";
  readonly title: string;
  readonly expected: string;
  readonly actual: string;
  readonly likelyFix: string;
  readonly skipped: string | null;
};

export type LiveView = {
  readonly phase: Phase;
  readonly finding: LiveFinding | null;
  readonly headline: string;
  readonly detail: string | null;
  readonly elapsedS: number;
  readonly lastContactS: number | null;
  /** Seconds left in the 90 s delivery wait, while it runs. */
  readonly waitLeftS: number | null;
  /** True once nothing more can arrive on this page: the run has finished or died. */
  readonly settled: boolean;
  readonly calls: readonly LiveCall[];
  readonly deliveries: readonly LiveDelivery[];
  readonly pairs: readonly LivePair[];
  readonly ledger: readonly LedgerRow[];
  readonly storeUnread: boolean;
};

const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const secs = (fromIso: string, toIso: string) => Math.max(0, (Date.parse(toIso) - Date.parse(fromIso)) / 1000);

function idsOf(v: unknown): Record<string, string> {
  if (typeof v !== "object" || v === null) return {};
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v)) if (typeof val === "string") out[k] = val;
  return out;
}

const HEADLINES: Record<Phase, string> = {
  queued: "Queued. Waiting for the server to pick it up.",
  running: "Running in PayPal's sandbox.",
  waiting: "Every step has run. Waiting for PayPal's deliveries.",
  complete: "Complete. Every step succeeded.",
  halted: "Stopped. A step did not succeed, so the run went no further.",
  abandoned: "The server running this stopped.",
  failed: "The run stopped on an internal error.",
};

/** Merges a page of events into what the page already holds, by sequence number. */
export function mergeEvents(held: readonly LiveEvent[], page: readonly LiveEvent[]): LiveEvent[] {
  const bySeq = new Map(held.map((e) => [e.seq, e]));
  for (const e of page) bySeq.set(e.seq, e);
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

export function liveView(read: LiveRead): LiveView {
  const { run, events, now } = read;
  const t0 = run.started_at ?? run.created_at;
  const tOf = (iso: string) => secs(t0, iso);

  const waitStart = events.find((e) => e.kind === "deliveries_wait_started");
  const waitEnded = events.some((e) => e.kind === "deliveries_wait_ended");
  const phase: Phase =
    run.status === "queued"
      ? "queued"
      : run.status === "running"
        ? waitStart !== undefined && !waitEnded
          ? "waiting"
          : "running"
        : (["complete", "halted", "abandoned", "failed"] as const).find((p) => p === run.status) ?? "failed";
  const settled = phase === "complete" || phase === "halted" || phase === "abandoned" || phase === "failed";
  const dead = phase === "abandoned" || phase === "failed";

  // Calls: the last word on each step, in the order they started.
  const started = new Map<string, LiveEvent>();
  const finished = new Map<string, LiveEvent>();
  for (const e of events) {
    if (e.step_id === null) continue;
    if (e.kind === "step_started" && !started.has(e.step_id)) started.set(e.step_id, e);
    if (e.kind === "step_finished") finished.set(e.step_id, e);
  }
  const calls: LiveCall[] = [...started.values()].map((s) => {
    const step = s.step_id!;
    const f = finished.get(step);
    const kind = str(s.data["kind"]) ?? "step";
    if (f === undefined) {
      return {
        key: `c:${step}`,
        step,
        kind,
        t: tOf(s.at),
        at: s.at,
        status: dead ? "never-confirmed" : "in-flight",
        detail: dead ? "started and never confirmed: it may have written to PayPal. Nothing here will retry it." : "calling PayPal",
        ids: {},
      };
    }
    const status = str(f.data["status"]);
    return {
      key: `c:${step}`,
      step,
      kind,
      t: tOf(f.at),
      at: f.at,
      status: status === "succeeded" || status === "failed" ? status : "unknown",
      detail: str(f.data["detail"]) ?? "",
      ids: idsOf(f.data["ids"]),
    };
  });

  // The store's records, as the worker saw them.
  const ledgerById = new Map<string, LedgerRow>();
  const orders = new Map<string, LiveEvent>();
  const redeliveries = new Map<string, LiveEvent>();
  let storeUnread = false;
  let finding: LiveFinding | null = null;
  for (const e of events) {
    if (e.kind === "delivery") {
      const id = str(e.data["event_id"]);
      if (id === null) continue;
      const deliveries = num(e.data["deliveries"]);
      const prev = ledgerById.get(id);
      ledgerById.set(id, {
        eventId: id,
        eventType: str(e.data["event_type"]),
        deliveries,
        fulfilled: num(e.data["fulfilled"]),
        duplicatesIgnored: num(e.data["duplicates_ignored"]),
        refused: num(e.data["refused"]),
        certHosts: Array.isArray(e.data["cert_hosts"]) ? e.data["cert_hosts"].filter((h): h is string => typeof h === "string") : [],
        firstSeenT: prev?.firstSeenT ?? tOf(e.at),
      });
      if (deliveries >= 2 && !redeliveries.has(id)) redeliveries.set(id, e);
    }
    if (e.kind === "note") {
      const order = e.data["order"];
      if (typeof order === "object" && order !== null) {
        const capture = str((order as Record<string, unknown>)["capture_id"]);
        if (capture !== null && !orders.has(capture)) orders.set(capture, e);
      }
      if ("store_read_failed" in e.data) storeUnread = true;
      const f = e.data["finding"];
      if (typeof f === "object" && f !== null) {
        const r = f as Record<string, unknown>;
        const verdict = r["verdict"];
        finding = {
          classId: str(r["class_id"]) ?? "unknown",
          // Anything but the three verdicts reads as inconclusive, never as ok.
          verdict: verdict === "bug" || verdict === "ok" ? verdict : "inconclusive",
          title: str(r["title"]) ?? "",
          expected: str(r["expected"]) ?? "",
          actual: str(r["actual"]) ?? "",
          likelyFix: str(r["likely_fix"]) ?? "",
          skipped: str(r["skipped"]),
        };
      }
    }
  }

  // Exact pairs only.
  const pairs: LivePair[] = [];
  const deliveries: LiveDelivery[] = [];
  for (const c of calls) {
    if (c.status !== "succeeded") continue;
    if (c.kind === "card_order" && c.ids["capture_id"] !== undefined) {
      const capture = c.ids["capture_id"];
      const seen = orders.get(capture);
      const key = `d:order:${capture}`;
      if (seen !== undefined) {
        const o = seen.data["order"] as Record<string, unknown>;
        deliveries.push({
          key,
          pair: c.key,
          t: tOf(seen.at),
          at: seen.at,
          title: "PAYMENT.CAPTURE.COMPLETED",
          facts: [
            ["capture", capture],
            ["store", num(o["fulfilled"]) === 1 ? "fulfilled" : `fulfilled ${num(o["fulfilled"])} times`],
          ],
        });
      }
      pairs.push({ callKey: c.key, deliveryKey: key, what: "the store's order for this capture", callT: c.t, arrivedT: seen === undefined ? null : tOf(seen.at) });
    }
    if (c.kind === "resend_webhook" && c.ids["resent_event_id"] !== undefined) {
      const eventId = c.ids["resent_event_id"];
      const seen = redeliveries.get(eventId);
      const key = `d:redelivery:${eventId}`;
      if (seen !== undefined) {
        deliveries.push({
          key,
          pair: c.key,
          t: tOf(seen.at),
          at: seen.at,
          title: `${str(seen.data["event_type"]) ?? "event"} · 2nd delivery`,
          facts: [
            ["event", eventId],
            ["store", num(seen.data["duplicates_ignored"]) > 0 ? "duplicate_ignored" : `fulfilled ${num(seen.data["fulfilled"])} times`],
          ],
        });
      }
      pairs.push({ callKey: c.key, deliveryKey: key, what: "the second delivery of the resent event", callT: c.t, arrivedT: seen === undefined ? null : tOf(seen.at) });
    }
  }

  const waitLeftS =
    phase === "waiting" && waitStart !== undefined
      ? Math.max(0, num(waitStart.data["seconds"]) - secs(waitStart.at, now))
      : null;

  let detail: string | null = null;
  if (phase === "halted" || phase === "abandoned" || phase === "failed") detail = run.halt_reason;
  if (phase === "complete") {
    const missing = pairs.filter((p) => p.arrivedT === null).length;
    if (missing > 0) detail = `${missing} expected ${missing === 1 ? "delivery was" : "deliveries were"} not seen when the 90 s wait ended. That is not proof the store missed ${missing === 1 ? "it" : "them"}: PayPal's sandbox has delivered later than that before.`;
  }

  return {
    phase,
    finding,
    headline: HEADLINES[phase],
    detail,
    elapsedS: secs(t0, run.finished_at ?? now),
    lastContactS: run.heartbeat_at === null ? null : secs(run.heartbeat_at, now),
    waitLeftS,
    settled,
    calls,
    deliveries,
    pairs,
    ledger: [...ledgerById.values()],
    storeUnread,
  };
}

/** "within 12 s": a delivery is seen when the worker polls, so this is an upper bound. */
export function withinLabel(seconds: number): string {
  return `within ${Math.max(0, Math.round(seconds))} s`;
}

/** The run id shape, kept here so a page can check it without importing the engine. */
export const RUN_ID_SHAPE = /^\d{14}-[0-9a-f]{6}$/;
