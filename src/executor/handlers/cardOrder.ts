import { errorSummary, pick } from "../../core/json";
import { classify } from "../../core/outcome";
import { cardOrderBody } from "../../core/sandboxFixtures";
import { type StepHandler, failed, succeeded, unknown, wrongKind } from "../types";

/**
 * Single-step Orders v2: intent CAPTURE plus payment_source.card, so PayPal
 * processes the card on the create call. No separate capture request and no
 * approval redirect. This is the path gate 1 proved.
 */
export const cardOrderHandler: StepHandler = async (ctx) => {
  const step = ctx.step;
  if (step.kind !== "card_order") return wrongKind("card_order", step.kind);

  const currency = ctx.scenario.currency;
  const res = await ctx.seller.call({
    method: "POST",
    path: "/v2/checkout/orders",
    idempotencySeed: ctx.seed,
    // Without this the response is a bare id and status, and the capture id
    // a later refund step needs never arrives.
    extraHeaders: { Prefer: "return=representation" },
    body: cardOrderBody(step.amount, currency, step.id),
  });

  const ids: Record<string, string> = {};
  const orderId = pick(res.body, ["id"]);
  if (orderId !== null) ids["order_id"] = orderId;
  const captureId = pick(res.body, ["purchase_units", 0, "payments", "captures", 0, "id"]);
  if (captureId !== null) ids["capture_id"] = captureId;

  const orderStatus = pick(res.body, ["status"]);
  if (orderStatus === "PAYER_ACTION_REQUIRED") {
    return failed(
      "card order needs a browser approval, so it cannot run unattended; check that advanced card processing is still enabled",
      ids,
    );
  }

  const verdict = classify({
    httpStatus: res.status,
    body: res.body,
    expect: ["COMPLETED"],
    knownFailed: ["VOIDED"],
  });
  if (verdict.kind !== "success") {
    const detail = `order did not complete: http ${res.status}, ${errorSummary(res.body, res.debugId)}`;
    return verdict.kind === "failed" ? failed(detail, ids) : unknown(detail, ids);
  }

  if (captureId === null) {
    return unknown("order reported COMPLETED but carried no capture id", ids);
  }

  const captureStatus = pick(res.body, [
    "purchase_units",
    0,
    "payments",
    "captures",
    0,
    "status",
  ]);
  if (captureStatus !== "COMPLETED") {
    return unknown(`capture status is ${captureStatus ?? "unreadable"}, not COMPLETED`, ids);
  }

  const capturedValue = pick(res.body, [
    "purchase_units",
    0,
    "payments",
    "captures",
    0,
    "amount",
    "value",
  ]);
  if (capturedValue !== step.amount) {
    return failed(`captured ${capturedValue ?? "unreadable"}, expected ${step.amount}`, ids);
  }

  return succeeded(`captured ${currency} ${step.amount} by card, no human step`, ids);
};
