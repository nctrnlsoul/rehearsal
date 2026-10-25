import type { Db, StoreAction, StoreRow, VerifiedAction } from "./db";

/**
 * The merchant app's own logic: what a typical small shop does when PayPal
 * tells it something happened.
 *
 * ======================== PLANTED BUG, NOW FIXED ========================
 * PayPal REDELIVERS webhook events, and an event can also be resent on
 * demand. A merchant app must therefore treat the event id as an
 * idempotency key. With this constant false, a second delivery of the same
 * PAYMENT.CAPTURE.COMPLETED fulfils the order a second time; the finder
 * caught exactly that (run 20261023231552-60ea96).
 *
 * THE ONE-LINE FIX, applied: this constant is true. Set it back to false
 * to replay the "before" state of the demo.
 * =======================================================================
 */
export const DEDUPE_BY_EVENT_ID = true;

export type ParsedEvent = {
  eventId: string | null;
  eventType: string;
  captureId: string | null;
  amount: string | null;
  currency: string | null;
};

/**
 * Longest event field the store records. PayPal ids, types, amounts and
 * currency codes are all far shorter; anything longer did not come from PayPal
 * and is recorded as absent rather than stored. Migration 0004 holds the same
 * line in the database.
 */
export const MAX_FIELD_CHARS = 128;

const str = (v: unknown): string | null =>
  typeof v === "string" && v.trim() !== "" && v.length <= MAX_FIELD_CHARS ? v : null;

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

export function actionFor(eventType: string): VerifiedAction {
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

/** Bounded, single-line text: the endpoint is public, and reasons can echo request data. */
export const MAX_REASON_CHARS = 200;

export function cleanReason(raw: string): string {
  const flat = raw.replace(/[\p{Cc}\p{Cf}]+/gu, " ").replace(/\s+/g, " ").trim();
  const chars = Array.from(flat);
  const cut = chars.length <= MAX_REASON_CHARS ? flat : chars.slice(0, MAX_REASON_CHARS).join("");
  return cut === "" ? "refused" : cut;
}

/** Longest a DNS name can be. Anything longer is not a host, so it is not recorded. */
const MAX_HOST_CHARS = 253;

/**
 * The host a delivery's paypal-cert-url names, for the record only. URL parsing
 * lower-cases it and leaves no control characters, so it is safe to store and
 * print. Null when the header is absent, unparseable, or absurd.
 */
export function certHostOf(certUrl: string | null): string | null {
  if (certUrl === null || certUrl.trim() === "") return null;
  let host: string;
  try {
    host = new URL(certUrl).hostname;
  } catch {
    return null;
  }
  return host === "" || host.length > MAX_HOST_CHARS ? null : host;
}

/**
 * Records a request refused before it could even be read as an event, such as
 * a body that is not JSON. Without a row it would be invisible, and a refused
 * delivery would look exactly like one that never arrived.
 */
export async function recordRefusal(db: Db, reason: string): Promise<void> {
  await db.insert(refusedRow(null, reason));
}

/**
 * A refused row keeps the reason and nothing the request claimed. The endpoint
 * is public, so every other field would be whatever an anonymous caller chose
 * to send, at whatever size, and none of it is evidence of anything.
 */
function refusedRow(verified: boolean | null, reason: string): Omit<StoreRow, "receivedAtMs"> {
  return {
    eventId: null,
    eventType: "UNKNOWN",
    captureId: null,
    amount: null,
    currency: null,
    action: "refused",
    verified,
    reason: cleanReason(reason),
    certHost: null,
  };
}

export async function handleEvent(
  db: Db,
  body: unknown,
  opts: { verified: boolean | null; detail?: string; certHost?: string | null; dedupe?: boolean },
): Promise<StoreAction> {
  const parsed = readEvent(body);
  const certHost = opts.certHost ?? null;
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
    const why =
      opts.detail ?? (opts.verified === false ? "signature did not verify" : "could not verify");
    await db.insert(refusedRow(opts.verified, why));
    return "refused";
  }

  const action = actionFor(parsed.eventType);

  // The check and the insert are one atomic call, so two deliveries of one
  // event arriving together cannot both act. A duplicate is still recorded
  // rather than dropped, so it is visible as handled.
  if (dedupe && parsed.eventId !== null) {
    return db.recordOnce({ ...parsed, eventId: parsed.eventId, action, certHost });
  }

  // The planted bug's path, and the path for an event with no id to dedupe on.
  await db.insert({ ...parsed, action, verified: opts.verified, reason: null, certHost });
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

/**
 * What happened to each delivery of one PayPal event id. This is the evidence a
 * duplicate check needs: per capture, two fulfilments could in principle be
 * two different events, but two rows for one event id are one event delivered
 * twice.
 */
export type DeliveryState = {
  eventId: string;
  eventType: string;
  fulfilled: number;
  duplicatesIgnored: number;
  /** Every other action, including refusals. */
  other: number;
  /** Of `other`, how many were refused, and the distinct reasons why. */
  refused: number;
  refusalReasons: string[];
  /** Distinct cert hosts the deliveries named, so an original and a resend can be compared. */
  certHosts: string[];
};

/** Refusals that could not be tied to an event, such as a body that was not JSON. */
export type UnattributedRefusals = { count: number; reasons: string[] };

/** Enough to diagnose, bounded so junk on the public endpoint cannot bloat the reply. */
const MAX_REASONS = 5;

export type StoreState = {
  orders: OrderState[];
  deliveries: DeliveryState[];
  unattributedRefusals: UnattributedRefusals;
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

  const addReason = (list: string[], reason: string | null) => {
    const r = reason ?? "no reason recorded";
    if (list.length < MAX_REASONS && !list.includes(r)) list.push(r);
  };

  const byEvent = new Map<string, DeliveryState>();
  const unattributedRefusals: UnattributedRefusals = { count: 0, reasons: [] };
  for (const row of rows) {
    if (row.eventId === null) {
      if (row.action === "refused") {
        unattributedRefusals.count += 1;
        addReason(unattributedRefusals.reasons, row.reason);
      }
      continue;
    }
    const current =
      byEvent.get(row.eventId) ??
      {
        eventId: row.eventId,
        eventType: row.eventType,
        fulfilled: 0,
        duplicatesIgnored: 0,
        other: 0,
        refused: 0,
        refusalReasons: [],
        certHosts: [],
      };
    if (row.action === "fulfilled") current.fulfilled += 1;
    else if (row.action === "duplicate_ignored") current.duplicatesIgnored += 1;
    else current.other += 1;
    if (row.action === "refused") {
      current.refused += 1;
      addReason(current.refusalReasons, row.reason);
    }
    if (
      row.certHost !== null &&
      current.certHosts.length < MAX_REASONS &&
      !current.certHosts.includes(row.certHost)
    ) {
      current.certHosts.push(row.certHost);
    }
    byEvent.set(row.eventId, current);
  }

  return {
    orders: [...byCapture.values()],
    deliveries: [...byEvent.values()],
    unattributedRefusals,
    eventCount: rows.length,
    unverifiedCount: rows.filter((r) => r.verified === false).length,
  };
}
