import type { Db, StoreAction, StoreRow } from "./db";

/**
 * The merchant app's own logic: what a typical small shop does when PayPal
 * tells it something happened.
 *
 * ============================= PLANTED BUG =============================
 * PayPal REDELIVERS webhook events, and an event can also be resent on
 * demand. A merchant app must therefore treat the event id as an
 * idempotency key. This one does not, so a second delivery of the same
 * PAYMENT.CAPTURE.COMPLETED fulfils the order a second time.
 *
 * THE ONE-LINE FIX: change this constant to true.
 * =======================================================================
 */
export const DEDUPE_BY_EVENT_ID = false;

export type ParsedEvent = {
  eventId: string | null;
  eventType: string;
  captureId: string | null;
  amount: string | null;
  currency: string | null;
};

const str = (v: unknown): string | null =>
  typeof v === "string" && v.trim() !== "" ? v : null;

const obj = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

export function readEvent(body: unknown): ParsedEvent {
  const e = obj(body);
  const resource = obj(e["resource"]);

  // Capture events carry the capture as resource.id. Dispute events carry the
  // disputed transaction instead.
  const disputed = Array.isArray(resource["disputed_transactions"])
    ? obj(resource["disputed_transactions"][0])
    : {};

  const amountHolder = obj(resource["amount"]);
  const disputeAmount = obj(resource["dispute_amount"]);

  return {
    eventId: str(e["id"]),
    eventType: str(e["event_type"]) ?? "UNKNOWN",
    captureId:
      str(resource["id"]) ??
      str(disputed["seller_transaction_id"]) ??
      str(disputed["buyer_transaction_id"]),
    amount: str(amountHolder["value"]) ?? str(disputeAmount["value"]),
    currency: str(amountHolder["currency_code"]) ?? str(disputeAmount["currency_code"]),
  };
}

export function actionFor(eventType: string): StoreAction {
  switch (eventType) {
    case "PAYMENT.CAPTURE.COMPLETED":
      return "fulfilled";
    case "PAYMENT.CAPTURE.REFUNDED":
      return "refund_recorded";
    case "CUSTOMER.DISPUTE.CREATED":
      return "dispute_noted";
    default:
      return "ignored";
  }
}

export async function handleEvent(
  db: Db,
  body: unknown,
  opts: { verified: boolean | null; dedupe?: boolean },
): Promise<StoreAction> {
  const parsed = readEvent(body);
  const dedupe = opts.dedupe ?? DEDUPE_BY_EVENT_ID;

  /**
   * An event whose signature did not verify never acts. The webhook endpoint is
   * public, so without this anyone could post a forged
   * PAYMENT.CAPTURE.COMPLETED and have an order fulfilled for free.
   *
   * verified === null means the store could not check at all, which is also not
   * grounds to act. This is NOT the planted bug: the planted bug is the missing
   * dedupe below, and a second real hole would muddy what the finder catches.
   */
  if (opts.verified !== true) {
    await db.insert({ ...parsed, action: "ignored", verified: opts.verified });
    return "ignored";
  }

  if (dedupe && parsed.eventId !== null && (await db.hasEvent(parsed.eventId))) {
    // Recorded rather than dropped, so a duplicate is visible as handled.
    await db.insert({ ...parsed, action: "duplicate_ignored", verified: opts.verified });
    return "duplicate_ignored";
  }

  const action = actionFor(parsed.eventType);
  await db.insert({ ...parsed, action, verified: opts.verified });
  return action;
}

export type OrderState = {
  captureId: string;
  fulfilmentCount: number;
  refundCount: number;
  disputeCount: number;
  duplicatesIgnored: number;
  amount: string | null;
  currency: string | null;
};

export type StoreState = {
  orders: OrderState[];
  eventCount: number;
  unverifiedCount: number;
};

/** Pure aggregation, which is what the edge-case finder reads. */
export function summarise(rows: readonly StoreRow[]): StoreState {
  const byCapture = new Map<string, OrderState>();

  for (const row of rows) {
    if (row.captureId === null) continue;
    const current =
      byCapture.get(row.captureId) ??
      {
        captureId: row.captureId,
        fulfilmentCount: 0,
        refundCount: 0,
        disputeCount: 0,
        duplicatesIgnored: 0,
        amount: null,
        currency: null,
      };

    if (row.action === "fulfilled") current.fulfilmentCount += 1;
    if (row.action === "refund_recorded") current.refundCount += 1;
    if (row.action === "dispute_noted") current.disputeCount += 1;
    if (row.action === "duplicate_ignored") current.duplicatesIgnored += 1;
    if (current.amount === null && row.amount !== null) current.amount = row.amount;
    if (current.currency === null && row.currency !== null) current.currency = row.currency;

    byCapture.set(row.captureId, current);
  }

  return {
    orders: [...byCapture.values()],
    eventCount: rows.length,
    unverifiedCount: rows.filter((r) => r.verified === false).length,
  };
}
