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

const short = (v: unknown, n: number): string | null => (typeof v === "string" && v !== "" ? cleanModelText(v, n) : null);
const count = (v: unknown): number => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : 0);

function boundedIds(ids: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(ids).slice(0, MAX_IDS)) {
    out[cleanModelText(k, MAX_ID_KEY_CHARS)] = cleanModelText(v, MAX_ID_CHARS);
  }
  return out;
}

/** What changed between two saves of one run. prev is null for the first save. */
export function stateEvents(prev: RunState | null, next: RunState): RunEvent[] {
  const events: RunEvent[] = [];
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
        data: { kind: n.kind, status: n.status, detail: cleanModelText(n.detail, MAX_DETAIL_CHARS), ids: boundedIds(n.ids) },
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
 * arriving shows up here). Orders are reported the same way, keyed by
 * capture id, because the store's per-event report carries no capture id:
 * the capture is the only thing that ties a delivery back to a call.
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
  return events;
}
