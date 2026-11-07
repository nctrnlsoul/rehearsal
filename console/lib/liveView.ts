/**
 * What the live run page draws, from one poll of GET /api/runs/[runId]. Pure,
 * so every state is tested without a browser.
 *
 * A call is joined to a delivery only where the pairing is exact: the
 * store records an id for each delivery (the capture, the refund, the
 * invoice, the dispute), and a delivery joins the one call whose own ids, or
 * whose source step's ids, include it, for an event type that call causes
 * (PAIR_RULES). A resend joins the second delivery of the event it resent.
 * A delivery that matches no call, or more than one, is never guessed at; it
 * stays in the ledger, unjoined.
 *
 * Times are the store's own receive times, so a latency is exact to the
 * second, give or take the two servers' clocks. A store deployed before it
 * reported receive times falls back to when the worker saw the delivery
 * (polled every 5 s), labeled "within" as an upper bound.
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
  /** The step this one acted on, when it names one ("from"). */
  readonly from: string | null;
};

export type LiveDelivery = {
  readonly key: string;
  readonly pair: string;
  readonly t: number;
  readonly at: string;
  readonly title: string;
  readonly facts: ReadonlyArray<readonly [string, string]>;
  /** True: at is the store's own receive time. False: when the worker saw it. */
  readonly received: boolean;
};

/** One call-delivery pair. arrivedT null: still waiting, or the wait ended without it. */
export type LivePair = {
  readonly callKey: string;
  readonly deliveryKey: string;
  readonly what: string;
  readonly callT: number;
  readonly arrivedT: number | null;
  /** True when arrivedT is the store's receive time, so the latency is exact. */
  readonly exact: boolean;
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
  /** The store's receive time of the first copy; null from a store that does not report it. */
  readonly firstReceivedT: number | null;
  /** The steps this delivery is joined to; empty when no call names it. */
  readonly joinedTo: readonly string[];
};

/** The finder's verdict, from the store's own records. */
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
const isoList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !Number.isNaN(Date.parse(x))) : []);
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x !== "") : []);

/**
 * Which deliveries a call causes: the event types, and which of the
 * call's ids the store records for them. The store records resource.id, which
 * is the capture, the order, the refund, the invoice or the dispute. viaFrom
 * ids are the source step's: an invoice payment names its invoice only
 * through the invoice_create step it came from. An event type not listed
 * here (an invoice update, say, which a send and a payment can both cause)
 * is never joined. An invoice's cancel event is not joined either: its type
 * is spelled the British way, which this console's spelling check refuses,
 * and neither recorded plan cancels an invoice. It stays in the
 * ledger, unjoined.
 */
type PairRule = { readonly kind: string; readonly types: readonly string[]; readonly own: readonly string[]; readonly viaFrom: readonly string[]; readonly what: string };
export const PAIR_RULES: readonly PairRule[] = [
  { kind: "card_order", types: ["PAYMENT.CAPTURE.COMPLETED"], own: ["capture_id"], viaFrom: [], what: "the capture's delivery" },
  { kind: "card_order", types: ["CHECKOUT.ORDER.APPROVED", "CHECKOUT.ORDER.COMPLETED"], own: ["order_id"], viaFrom: [], what: "the order's delivery" },
  { kind: "refund", types: ["PAYMENT.CAPTURE.REFUNDED"], own: ["refund_id"], viaFrom: [], what: "the refund's delivery" },
  { kind: "open_dispute", types: ["CUSTOMER.DISPUTE.CREATED"], own: ["dispute_id", "purchase_capture_id", "buyer_transaction_id"], viaFrom: [], what: "the dispute's delivery" },
  { kind: "invoice_create", types: ["INVOICING.INVOICE.CREATED"], own: ["invoice_id"], viaFrom: [], what: "the invoice's delivery" },
  { kind: "invoice_record_payment", types: ["INVOICING.INVOICE.PAID"], own: [], viaFrom: ["invoice_id"], what: "the payment's delivery" },
];

/** What the store did with an event's deliveries, as of one report. */
function storeWord(data: Record<string, unknown>): string {
  const fulfilled = num(data["fulfilled"]);
  if (num(data["duplicates_ignored"]) > 0) return "duplicate_ignored";
  if (fulfilled > 0) return fulfilled === 1 ? "fulfilled" : `fulfilled ${fulfilled} times`;
  if (num(data["refused"]) > 0) return "refused";
  return "recorded";
}

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
        from: null,
      };
    }
    const status = str(f.data["status"]);
    // The engine's own finish time when it is there; the save's otherwise.
    const at = isoList([f.data["finished_at"]])[0] ?? f.at;
    return {
      key: `c:${step}`,
      step,
      kind,
      t: tOf(at),
      at,
      status: status === "succeeded" || status === "failed" ? status : "unknown",
      detail: str(f.data["detail"]) ?? "",
      ids: idsOf(f.data["ids"]),
      from: str(f.data["from"]),
    };
  });

  // The store's records, as the worker saw them.
  const ledgerById = new Map<string, Omit<LedgerRow, "joinedTo">>();
  const orders = new Map<string, LiveEvent>();
  const firstReports = new Map<string, LiveEvent>();
  const latestReports = new Map<string, LiveEvent>();
  const redeliveries = new Map<string, LiveEvent>();
  let storeUnread = false;
  let finding: LiveFinding | null = null;
  for (const e of events) {
    if (e.kind === "delivery") {
      const id = str(e.data["event_id"]);
      if (id === null) continue;
      const deliveries = num(e.data["deliveries"]);
      const prev = ledgerById.get(id);
      const firstReceived = isoList(e.data["received_at"])[0];
      if (!firstReports.has(id)) firstReports.set(id, e);
      latestReports.set(id, e);
      ledgerById.set(id, {
        eventId: id,
        eventType: str(e.data["event_type"]),
        deliveries,
        fulfilled: num(e.data["fulfilled"]),
        duplicatesIgnored: num(e.data["duplicates_ignored"]),
        refused: num(e.data["refused"]),
        certHosts: Array.isArray(e.data["cert_hosts"]) ? e.data["cert_hosts"].filter((h): h is string => typeof h === "string") : [],
        firstSeenT: prev?.firstSeenT ?? tOf(e.at),
        firstReceivedT: firstReceived === undefined ? (prev?.firstReceivedT ?? null) : tOf(firstReceived),
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
  const joined = new Map<string, string[]>();
  const join = (eventId: string, step: string) => joined.set(eventId, [...(joined.get(eventId) ?? []), step]);
  const byStep = new Map(calls.map((c) => [c.step, c]));
  const succeeded = calls.filter((c) => c.status === "succeeded");
  const capturePaired = new Set<string>();

  for (const [eventId, latest] of latestReports) {
    const type = str(latest.data["event_type"]);
    const recorded = strList(latest.data["capture_ids"]);
    if (type === null || recorded.length === 0) continue;
    const matches: Array<{ call: LiveCall; rule: PairRule; id: string }> = [];
    for (const c of succeeded) {
      for (const rule of PAIR_RULES) {
        if (rule.kind !== c.kind || !rule.types.includes(type)) continue;
        const source = c.from === null ? undefined : byStep.get(c.from);
        const candidates = [...rule.own.map((l) => c.ids[l]), ...rule.viaFrom.map((l) => source?.ids[l])];
        const id = candidates.find((v): v is string => v !== undefined && recorded.includes(v));
        if (id !== undefined) matches.push({ call: c, rule, id });
      }
    }
    // None, or more than one: either way nothing says which call caused it.
    if (matches.length !== 1) continue;
    const { call, rule, id } = matches[0]!;
    const first = firstReports.get(eventId)!;
    const receivedAt = isoList(latest.data["received_at"])[0];
    const at = receivedAt ?? first.at;
    const key = `d:event:${eventId}`;
    deliveries.push({
      key,
      pair: call.key,
      t: tOf(at),
      at,
      title: type,
      facts: [
        ["event", eventId],
        [rule.own.includes("capture_id") ? "capture" : "id", id],
        ["store", storeWord(first.data)],
      ],
      received: receivedAt !== undefined,
    });
    pairs.push({ callKey: call.key, deliveryKey: key, what: rule.what, callT: call.t, arrivedT: tOf(at), exact: receivedAt !== undefined });
    join(eventId, call.step);
    if (type === "PAYMENT.CAPTURE.COMPLETED") capturePaired.add(call.key);
  }

  for (const c of succeeded) {
    // A card order is expected to cause a capture delivery, so it waits for one.
    if (c.kind === "card_order" && c.ids["capture_id"] !== undefined && !capturePaired.has(c.key)) {
      const capture = c.ids["capture_id"];
      // A store that reports no capture ids per delivery still reports its orders.
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
          received: false,
        });
      }
      pairs.push({ callKey: c.key, deliveryKey: key, what: "the capture's delivery", callT: c.t, arrivedT: seen === undefined ? null : tOf(seen.at), exact: false });
    }
    if (c.kind === "resend_webhook" && c.ids["resent_event_id"] !== undefined) {
      const eventId = c.ids["resent_event_id"];
      const seen = redeliveries.get(eventId);
      const latest = latestReports.get(eventId);
      const receivedAt = latest === undefined ? undefined : isoList(latest.data["received_at"])[1];
      const report = seen ?? (receivedAt === undefined ? undefined : latest);
      const at = receivedAt ?? seen?.at;
      const key = `d:redelivery:${eventId}`;
      if (report !== undefined && at !== undefined) {
        deliveries.push({
          key,
          pair: c.key,
          t: tOf(at),
          at,
          title: `${str(report.data["event_type"]) ?? "event"} · 2nd delivery`,
          facts: [
            ["event", eventId],
            ["store", num(report.data["duplicates_ignored"]) > 0 ? "duplicate_ignored" : `fulfilled ${num(report.data["fulfilled"])} times`],
          ],
          received: receivedAt !== undefined,
        });
        join(eventId, c.step);
      }
      pairs.push({ callKey: c.key, deliveryKey: key, what: "the second delivery of the resent event", callT: c.t, arrivedT: at === undefined ? null : tOf(at), exact: receivedAt !== undefined });
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
    ledger: [...ledgerById.values()].map((l) => ({ ...l, joinedTo: joined.get(l.eventId) ?? [] })),
    storeUnread,
  };
}

/** "within 12 s": a delivery is seen when the worker polls, so this is an upper bound. */
export function withinLabel(seconds: number): string {
  return `within ${Math.max(0, Math.round(seconds))} s`;
}

/** An exact latency from the store's receive time, to the second, as the replays print it. */
export function pairLabel(p: Pick<LivePair, "callT" | "arrivedT" | "exact">): string {
  if (p.arrivedT === null) return "";
  const s = p.arrivedT - p.callT;
  return p.exact ? `${Math.max(0, Math.round(s))} s` : withinLabel(s);
}

/** The run id shape, kept here so a page can check it without importing the engine. */
export const RUN_ID_SHAPE = /^\d{14}-[0-9a-f]{6}$/;
