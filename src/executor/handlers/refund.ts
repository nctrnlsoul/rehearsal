import { errorSummary, pick } from "../../core/json";
import { fromMinor, splitPartial, toMinor } from "../../core/money";
import { classify } from "../../core/outcome";
import {
  type StepHandler,
  failed,
  findStep,
  outputOf,
  succeeded,
  unknown,
  wrongKind,
} from "../types";

/**
 * Refunds the capture a card_order step produced, then re-reads the capture to
 * confirm the state PayPal now reports. The refund response alone is one system
 * agreeing with itself; re-reading the capture is the independent check, which
 * is what gate 2 established.
 */
export const refundHandler: StepHandler = async (ctx) => {
  const step = ctx.step;
  if (step.kind !== "refund") return wrongKind("refund", step.kind);

  const currency = ctx.scenario.currency;
  const captureId = outputOf(ctx, step.from, "capture_id");
  if (captureId === null) {
    return unknown(`step ${step.from} recorded no capture_id, so there is nothing to refund`);
  }

  const source = findStep(ctx.scenario, step.from);
  if (source === undefined || source.kind !== "card_order") {
    return unknown(`step ${step.from} is not a card_order step`);
  }

  const totalMinor = toMinor(source.amount, currency);
  const isPartial = step.mode === "partial";
  // A full refund sends no amount at all, which is how PayPal refunds the whole
  // capture without us restating a figure it already knows.
  const refundValue = isPartial
    ? fromMinor(splitPartial(totalMinor, step.basisPoints!).refundMinor, currency)
    : source.amount;

  ctx.log(`refunding ${currency} ${refundValue} of ${source.amount} (${step.mode})`);

  const res = await ctx.seller.call({
    method: "POST",
    path: `/v2/payments/captures/${captureId}/refund`,
    idempotencySeed: ctx.seed,
    extraHeaders: { Prefer: "return=representation" },
    body: {
      ...(isPartial ? { amount: { value: refundValue, currency_code: currency } } : {}),
      note_to_payer: `REHEARSAL ${step.id}`,
    },
  });

  const ids: Record<string, string> = {};
  const refundId = pick(res.body, ["id"]);
  if (refundId !== null) ids["refund_id"] = refundId;

  const verdict = classify({
    httpStatus: res.status,
    body: res.body,
    expect: ["COMPLETED"],
    knownFailed: ["CANCELLED", "FAILED"],
  });
  if (verdict.kind !== "success") {
    const detail = `refund did not complete: http ${res.status}, ${errorSummary(res.body, res.bodyPreview)}`;
    return verdict.kind === "failed" ? failed(detail, ids) : unknown(detail, ids);
  }

  const refunded = pick(res.body, ["amount", "value"]);
  if (isPartial && refunded !== refundValue) {
    return failed(`PayPal refunded ${refunded ?? "unreadable"}, we asked for ${refundValue}`, ids);
  }

  const check = await ctx.seller.call({
    method: "GET",
    path: `/v2/payments/captures/${captureId}`,
  });
  const captureStatus = pick(check.body, ["status"]);
  const wanted = isPartial ? "PARTIALLY_REFUNDED" : "REFUNDED";
  ctx.log(`capture now reads ${captureStatus ?? "unreadable"}`);

  if (captureStatus !== wanted) {
    return unknown(
      `refund reported COMPLETED but the capture reads ${captureStatus ?? "unreadable"}, not ${wanted}`,
      ids,
    );
  }

  return succeeded(`refunded ${currency} ${refunded ?? refundValue}; capture confirms ${wanted}`, ids);
};
