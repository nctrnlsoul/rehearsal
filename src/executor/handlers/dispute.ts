import { errorSummary, pick } from "../../core/json";
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

  const claim = ctx.claimPurchase();
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
    const detail = `buyer app could not create a dispute: http ${filed.status}, ${errorSummary(filed.body, filed.bodyPreview)}`;
    return filed.status >= 400 && filed.status < 500 ? failed(detail, ids) : unknown(detail, ids);
  }

  // Creation is asynchronous; the dispute is not immediately readable.
  const deadline = ctx.now().getTime() + POLL_BUDGET_MS;
  let status: string | null = null;
  let stage: string | null = null;

  for (let poll = 0; poll < MAX_POLLS && ctx.now().getTime() < deadline; poll += 1) {
    const look = await ctx.seller.call({
      method: "GET",
      path: `/v1/customer/disputes/${disputeId}`,
    });
    status = pick(look.body, ["status"]);
    stage = pick(look.body, ["dispute_life_cycle_stage"]);
    ctx.log(`dispute ${disputeId} reads ${status ?? "?"} at stage ${stage ?? "?"}`);
    if (status !== null && status !== "CREATION_IN_PROGRESS") break;
    await ctx.sleep(POLL_INTERVAL_MS);
  }

  if (status === null) {
    return unknown(`dispute ${disputeId} was created but never became readable`, ids);
  }
  if (status === "CREATION_IN_PROGRESS") {
    // The write landed and the id is recorded. The status simply has not settled,
    // which is a timing fact about PayPal, not an undetermined outcome.
    return succeeded(
      `dispute ${disputeId} created and still settling after ${POLL_BUDGET_MS / 1000}s`,
      ids,
    );
  }
  if (!OPEN_STATUSES.has(status)) {
    return failed(`dispute ${disputeId} reads ${status}, which is not an open dispute`, ids);
  }

  return succeeded(`dispute ${disputeId} open at ${status}, stage ${stage ?? "unknown"}`, ids);
};
