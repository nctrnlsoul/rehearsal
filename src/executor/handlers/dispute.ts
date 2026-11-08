import { errorSummary, pick, str } from "../../core/json";
import { selfLinkId } from "../../core/paypalLinks";
import { type StepHandler, failed, succeeded, unknown, wrongKind } from "../types";

const POLL_BUDGET_MS = 120_000;
const POLL_INTERVAL_MS = 8000;
/** Bounds the loop independently of the clock, so a stalled clock cannot hang a run. */
const MAX_POLLS = Math.ceil(POLL_BUDGET_MS / POLL_INTERVAL_MS) + 2;

/** States a freshly filed dispute may legitimately be sitting in. */
const OPEN_STATUSES = new Set([
  "OPEN",
  "WAITING_FOR_SELLER_RESPONSE",
  "WAITING_FOR_BUYER_RESPONSE",
  "UNDER_REVIEW",
]);

/** PayPal's read-back is untrusted text bound for the run record and the page. */
const MAX_NAMED = 5;
const MAX_ID_CHARS = 64;

/**
 * An id as recorded. Storage trims and strips control characters, so an id
 * that is not plain has every other character written out; two ids that
 * differ then never print alike, and none can carry the "; " separator.
 */
function shownId(id: string): string {
  const visible = /^[A-Za-z0-9_-]+$/.test(id)
    ? id
    : Array.from(id, (ch) => (/[A-Za-z0-9_-]/.test(ch) ? ch : `\\u{${ch.codePointAt(0)!.toString(16)}}`)).join("");
  return visible.length <= MAX_ID_CHARS ? visible : `${visible.slice(0, MAX_ID_CHARS)}...`;
}

type Pairing = { note: string; paypalIds: string | null; mismatch: boolean };

/**
 * What PayPal's read-back says the dispute is against, beside what the bank
 * says it is against. The bank's pairing of buyer txn id to capture can be
 * hand-entered and wrong, so only PayPal's own field is evidence of a match,
 * and only when every disputed transaction names the banked capture. Absent,
 * nothing is claimed either way.
 */
function pairingOf(body: unknown, bankedCapture: string | null): Pairing {
  const txns = typeof body === "object" && body !== null ? (body as Record<string, unknown>)["disputed_transactions"] : undefined;
  const perTxn = Array.isArray(txns)
    ? txns.map((t) => (typeof t === "object" && t !== null ? str((t as Record<string, unknown>)["seller_transaction_id"]) : null))
    : [];
  const named = [...new Set(perTxn.filter((id): id is string => id !== null))];
  if (named.length === 0) return { note: "PayPal did not name the capture", paypalIds: null, mismatch: false };
  // The comparison uses PayPal's raw values; only what is recorded and shown is rewritten.
  const paypalIds = `${named.slice(0, MAX_NAMED).map(shownId).join(", ")}${named.length > MAX_NAMED ? `, and ${named.length - MAX_NAMED} more` : ""}`;
  if (bankedCapture === null || named.some((id) => id !== bankedCapture)) {
    return { note: `pairing_mismatch: banked capture ${bankedCapture === null ? "(none)" : shownId(bankedCapture)}, PayPal says ${paypalIds}`, paypalIds, mismatch: true };
  }
  const unnamed = perTxn.filter((id) => id === null).length;
  if (unnamed > 0) {
    return { note: `PayPal names capture ${paypalIds} for ${perTxn.length - unnamed} of ${perTxn.length} disputed transactions, so the pairing is not confirmed`, paypalIds, mismatch: false };
  }
  return { note: `PayPal names capture ${paypalIds}, the banked capture`, paypalIds, mismatch: false };
}

/** A mismatch leads the detail, so no length cap downstream can cut it off. */
const withPairing = (text: string, p: Pairing) => (p.mismatch ? `${p.note}; ${text}` : `${text}; ${p.note}`);

/**
 * Opens a real buyer-side dispute against a banked purchase.
 *
 * The scenario ends with the dispute OPEN and waiting on the merchant. There is
 * deliberately no require-evidence or adjudicate: both are claim-stage tools and
 * both refuse at the INQUIRY stage a fresh dispute starts in, which the gate
 * established directly.
 *
 * The body shape is the one confirmed working in PayPal's Discord and absent
 * from the published spec: the buyer app's own token, no PayPal-Auth-Assertion,
 * and the BUYER-side transaction id rather than the seller's capture id.
 */
export const openDisputeHandler: StepHandler = async (ctx) => {
  const step = ctx.step;
  if (step.kind !== "open_dispute") return wrongKind("open_dispute", step.kind);

  const claim = await ctx.claimPurchase();
  if (!claim.ok) return failed(claim.error);
  const purchase = claim.purchase;

  const ids: Record<string, string> = {
    purchase_order_id: purchase.orderId,
  };
  if (purchase.captureId !== null) ids["purchase_capture_id"] = purchase.captureId;
  if (purchase.buyerTransactionId !== null) {
    ids["buyer_transaction_id"] = purchase.buyerTransactionId;
  }

  if (purchase.buyerTransactionId === null) {
    return unknown("the banked purchase carries no buyer-side transaction id", ids);
  }
  if (purchase.currency !== ctx.scenario.currency) {
    return failed(
      `banked purchase is in ${purchase.currency} but the scenario is in ${ctx.scenario.currency}`,
      ids,
    );
  }
  ids["dispute_amount"] = purchase.amount;

  ctx.log(`disputing banked purchase ${purchase.orderId} for ${purchase.currency} ${purchase.amount}`);

  const filed = await ctx.buyer.call({
    method: "POST",
    path: "/v1/customer/disputes",
    idempotencySeed: ctx.seed,
    body: {
      disputed_transactions: [{ buyer_transaction_id: purchase.buyerTransactionId }],
      reason: step.reason,
      dispute_amount: { currency_code: purchase.currency, value: purchase.amount },
      extensions: {
        merchant_contacted: true,
        merchant_contacted_outcome: "NO_RESPONSE",
        merchandize_dispute_properties: { issue_type: "PRODUCT" },
      },
    },
  });

  // A 201 here carries no id field at all: the dispute id lives only in the
  // self link. Missing it once made a successful write report as a failure.
  const disputeId =
    pick(filed.body, ["dispute_id"]) ?? pick(filed.body, ["id"]) ?? selfLinkId(filed.body);
  if (disputeId !== null) ids["dispute_id"] = disputeId;

  if (disputeId === null) {
    const detail = `buyer app could not create a dispute: http ${filed.status}, ${errorSummary(filed.body, filed.debugId)}`;
    return filed.status >= 400 && filed.status < 500 ? failed(detail, ids) : unknown(detail, ids);
  }

  // Creation is asynchronous; the dispute is not immediately readable.
  const deadline = ctx.now().getTime() + POLL_BUDGET_MS;
  let status: string | null = null;
  let stage: string | null = null;
  let body: unknown = null;

  for (let poll = 0; poll < MAX_POLLS && ctx.now().getTime() < deadline; poll += 1) {
    const look = await ctx.seller.call({
      method: "GET",
      path: `/v1/customer/disputes/${disputeId}`,
    });
    status = pick(look.body, ["status"]);
    stage = pick(look.body, ["dispute_life_cycle_stage"]);
    body = look.body;
    ctx.log(`dispute ${disputeId} reads ${status ?? "?"} at stage ${stage ?? "?"}`);
    if (status !== null && status !== "CREATION_IN_PROGRESS") break;
    await ctx.sleep(POLL_INTERVAL_MS);
  }

  // A mismatch keeps the outcome: the dispute is real, only its label is in doubt.
  // A reply with no readable status (an error body, say) is no read-back of the dispute.
  const pairing = pairingOf(status === null ? null : body, purchase.captureId);
  if (pairing.paypalIds !== null) ids["paypal_seller_transaction_id"] = pairing.paypalIds;

  if (status === null) {
    return unknown(withPairing(`dispute ${disputeId} was created but never became readable`, pairing), ids);
  }
  if (status === "CREATION_IN_PROGRESS") {
    // The write landed and the id is recorded. The status simply has not settled,
    // which is a timing fact about PayPal, not an undetermined outcome.
    return succeeded(
      withPairing(`dispute ${disputeId} created and still settling after ${POLL_BUDGET_MS / 1000}s`, pairing),
      ids,
    );
  }
  if (!OPEN_STATUSES.has(status)) {
    return failed(withPairing(`dispute ${disputeId} reads ${status}, which is not an open dispute`, pairing), ids);
  }

  return succeeded(withPairing(`dispute ${disputeId} open at ${status}, stage ${stage ?? "unknown"}`, pairing), ids);
};
