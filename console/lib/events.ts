import { type RunState, type StoreSnapshot, cleanModelText } from "./engine";

/**
 * Timeline events, derived from what the run saved and what the store
 * reported. Pure. Every field is bounded so an event always fits the table's
 * 4 KB check (migrations/0001), and no PayPal body ever lands in one: only
 * ids, statuses and the engine's own short details.
 */

export type EventKind =
  | "step_started"
  | "step_finished"
  | "run_halted"
  | "deliveries_wait_started"
  | "delivery"
  | "deliveries_wait_ended"
  | "note";

export type RunEvent = {
  readonly kind: EventKind;
  readonly step_id?: string;
  readonly data?: Record<string, unknown>;
};

export const MAX_DETAIL_CHARS = 300;
const MAX_IDS = 12;
const MAX_ID_KEY_CHARS = 40;
const MAX_ID_CHARS = 128;
const MAX_TEXT_CHARS = 100;
const MAX_HOSTS = 3;
/** The store reports at most five of each. */
const MAX_DELIVERY_IDS = 5;

const short = (v: unknown, n: number): string | null => (typeof v === "string" && v !== "" ? cleanModelText(v, n) : null);
const count = (v: unknown): number => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : 0);

/** An ISO timestamp, re-serialized so only a real time is stored. Anything else is no time. */
function isoOrNull(v: unknown): string | null {
  if (typeof v !== "string" || v.length > 40) return null;
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

const nonNull = <T>(v: T | null): v is T => v !== null;

function boundedIds(ids: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(ids).slice(0, MAX_IDS)) {
    out[cleanModelText(k, MAX_ID_KEY_CHARS)] = cleanModelText(v, MAX_ID_CHARS);
  }
  return out;
}

/**
 * The run state as it is saved, and later served by GET /api/runs/[id]: step
 * details and the halt reason cleaned and capped like the events, so nothing
 * longer than the engine's short summary of a PayPal reply is ever stored.
 */
export function savedState(s: RunState): RunState {
  const steps: Record<string, RunState["steps"][string]> = {};
  for (const [id, step] of Object.entries(s.steps)) steps[id] = { ...step, detail: cleanModelText(step.detail, MAX_DETAIL_CHARS) };
  return { ...s, steps, haltReason: s.haltReason === null ? null : cleanModelText(s.haltReason, MAX_DETAIL_CHARS) };
}

/** What the run page needs to name a step before it starts: its kind, its amount, what it acts on. */
export type PlanStepFact = {
  readonly id: string;
  readonly kind: string;
  readonly amount?: string;
  readonly from?: string;
  readonly mode?: string;
  readonly basisPoints?: number;
  readonly eventType?: string;
};
export type PlanFacts = { readonly currency: string; readonly steps: readonly PlanStepFact[] };

const MAX_PLAN_STEPS = 12;
/** Half the 4 KB pg_column_size check, since jsonb adds per-key and per-value overhead to the text size. */
const MAX_PLAN_BYTES = 2000;
const AMOUNT_SHAPE = /^\d{1,9}(\.\d{1,2})?$/;

/** The plan's steps, bounded like every other field, for the note the first save records. */
export function planFacts(scenario: { currency: string; steps: readonly unknown[] }): PlanFacts {
  const steps = scenario.steps.slice(0, MAX_PLAN_STEPS).map((raw) => {
    const s = raw as Record<string, unknown>;
    const text = (k: string, n: number) => (typeof s[k] === "string" && s[k] !== "" ? cleanModelText(s[k] as string, n) : undefined);
    let amount = typeof s["amount"] === "string" && AMOUNT_SHAPE.test(s["amount"]) ? (s["amount"] as string) : undefined;
    // A payout's amount is the sum of its items, in integer cents.
    if (amount === undefined && Array.isArray(s["items"])) {
      let cents = 0n;
      let ok = s["items"].length > 0;
      for (const item of s["items"]) {
        const a = (item as Record<string, unknown> | null)?.["amount"];
        const m = typeof a === "string" ? /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(a) : null;
        if (m === null) ok = false;
        else cents += BigInt(m[1]!) * 100n + BigInt((m[2] ?? "").padEnd(2, "0"));
      }
      if (ok) amount = `${cents / 100n}.${String(cents % 100n).padStart(2, "0")}`;
    }
    const bp = s["basisPoints"];
    const fact: PlanStepFact = {
      id: text("id", MAX_ID_KEY_CHARS) ?? "step",
      kind: text("kind", MAX_ID_KEY_CHARS) ?? "step",
      ...(amount === undefined ? {} : { amount }),
      ...(text("from", MAX_ID_KEY_CHARS) === undefined ? {} : { from: text("from", MAX_ID_KEY_CHARS)! }),
      ...(text("mode", 20) === undefined ? {} : { mode: text("mode", 20)! }),
      ...(typeof bp === "number" && Number.isInteger(bp) && bp > 0 && bp < 10_000 ? { basisPoints: bp } : {}),
      ...(text("eventType", 60) === undefined ? {} : { eventType: text("eventType", 60)! }),
    };
    return fact;
  });
  // An event over the table's 4 KB check would fail the first save and stop
  // the run before it starts, so steps are dropped from the end until it fits.
  while (steps.length > 0 && new TextEncoder().encode(JSON.stringify({ plan: { currency: scenario.currency, steps } })).length > MAX_PLAN_BYTES) steps.pop();
  return { currency: cleanModelText(scenario.currency, 3), steps };
}

/**
 * What changed between two saves of one run. prev is null for the first save.
 * sources maps a step to the step it names in "from" (an invoice payment to
 * its invoice), so the timeline can find the ids a step acted on. plan, when
 * given, is recorded once, on the first save, so the page can name every
 * step and its amount before any of them runs.
 */
export function stateEvents(prev: RunState | null, next: RunState, sources: ReadonlyMap<string, string> = new Map(), plan: PlanFacts | null = null): RunEvent[] {
  const events: RunEvent[] = [];
  if (prev === null && plan !== null) events.push({ kind: "note", data: { plan } });
  for (const id of next.order) {
    const n = next.steps[id];
    if (n === undefined) continue;
    const p = prev?.steps[id];
    if (n.startedAt !== null && (p === undefined || p.startedAt !== n.startedAt || p.attempts !== n.attempts)) {
      events.push({ kind: "step_started", step_id: id, data: { kind: n.kind, attempt: n.attempts } });
    }
    if (n.finishedAt !== null && n.status !== "pending" && p?.finishedAt !== n.finishedAt) {
      events.push({
        kind: "step_finished",
        step_id: id,
        data: {
          kind: n.kind,
          status: n.status,
          detail: cleanModelText(n.detail, MAX_DETAIL_CHARS),
          ids: boundedIds(n.ids),
          // When PayPal's answer came back, on the engine's clock, rather than when the save landed.
          finished_at: isoOrNull(n.finishedAt),
          ...(sources.has(id) ? { from: cleanModelText(sources.get(id)!, MAX_ID_CHARS) } : {}),
        },
      });
    }
  }
  const hook = next.meta["webhook_id"];
  if (hook !== undefined && prev?.meta["webhook_id"] !== hook) {
    events.push({ kind: "note", data: { webhook_id: cleanModelText(hook, MAX_ID_CHARS) } });
  }
  if (next.halted && prev?.halted !== true) {
    events.push({ kind: "run_halted", data: { reason: cleanModelText(next.haltReason ?? "no reason recorded", MAX_DETAIL_CHARS) } });
  }
  return events;
}

/** Totals per event id or capture id, as last reported, so only changes become events. */
export type SeenDeliveries = Map<string, number>;

/**
 * New deliveries in a store snapshot. A delivery event is emitted the first
 * time an event id appears, and again whenever its total grows (a resend
 * arriving shows up here). Each carries the ids the store recorded for it and
 * when it received each copy, which is what ties a delivery to the
 * call that caused it. Orders are reported too, keyed by capture id, for a
 * store deployed before it reported those.
 */
export function deliveryEvents(snapshot: StoreSnapshot, seen: SeenDeliveries, seenAtIso: string): RunEvent[] {
  const events: RunEvent[] = [];
  for (const raw of snapshot.deliveries ?? []) {
    const d = raw as unknown as Record<string, unknown>;
    const eventId = short(d["eventId"], MAX_ID_CHARS);
    if (eventId === null) continue;
    const fulfilled = count(d["fulfilled"]);
    const duplicatesIgnored = count(d["duplicatesIgnored"]);
    const other = count(d["other"]);
    const total = fulfilled + duplicatesIgnored + other;
    const key = `event:${eventId}`;
    if (total <= (seen.get(key) ?? 0)) continue;
    seen.set(key, total);
    const hosts = Array.isArray(d["certHosts"]) ? d["certHosts"].slice(0, MAX_HOSTS).map((h) => short(h, MAX_TEXT_CHARS)).filter((h) => h !== null) : [];
    events.push({
      kind: "delivery",
      data: {
        event_id: eventId,
        event_type: short(d["eventType"], MAX_TEXT_CHARS),
        deliveries: total,
        fulfilled,
        duplicates_ignored: duplicatesIgnored,
        other,
        refused: count(d["refused"]),
        cert_hosts: hosts,
        capture_ids: Array.isArray(d["captureIds"]) ? d["captureIds"].slice(0, MAX_DELIVERY_IDS).map((c) => short(c, MAX_ID_CHARS)).filter(nonNull) : [],
        received_at: Array.isArray(d["receivedAt"]) ? d["receivedAt"].slice(0, MAX_DELIVERY_IDS).map(isoOrNull).filter(nonNull) : [],
        seen_at: seenAtIso,
      },
    });
  }
  for (const raw of snapshot.orders) {
    const o = raw as unknown as Record<string, unknown>;
    const captureId = short(o["captureId"], MAX_ID_CHARS);
    if (captureId === null) continue;
    const fulfilled = count(o["fulfilmentCount"]);
    const refunds = count(o["refundCount"]);
    const disputes = count(o["disputeCount"]);
    const duplicates = count(o["duplicatesIgnored"]);
    const total = fulfilled + refunds + disputes + duplicates;
    const key = `order:${captureId}`;
    if (total <= (seen.get(key) ?? 0)) continue;
    seen.set(key, total);
    events.push({
      kind: "note",
      data: { order: { capture_id: captureId, fulfilled, refunds, disputes, duplicates_ignored: duplicates }, seen_at: seenAtIso },
    });
  }
  // Copies the store refused carry no event id, so they never show as a
  // delivery above. Their count in this run's window is said whenever it
  // grows, so the page can never call every signature verified past one.
  const raw = snapshot as unknown as Record<string, unknown>;
  const loose = raw["unattributedRefusals"] as Record<string, unknown> | undefined;
  const refused = Math.max(count(loose?.["count"]), count(raw["unverifiedCount"]));
  if (refused > (seen.get("refused") ?? 0)) {
    seen.set("refused", refused);
    events.push({ kind: "note", data: { refused_in_window: refused, seen_at: seenAtIso } });
  }
  return events;
}
