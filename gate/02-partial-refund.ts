import { credentialsFor } from "../src/adapters/env";
import { PaypalClient } from "../src/adapters/paypal";
import { seedOf } from "../src/core/idempotency";
import { fromMinor, splitPartial, toMinor } from "../src/core/money";
import { classify } from "../src/core/outcome";
import { errorSummary, loadState, pick, runGate, saveState } from "./_harness";

/**
 * Gate 2: partially refund the capture gate 1 created, then confirm the capture
 * itself now reads PARTIALLY_REFUNDED. The refund response alone is one system
 * agreeing with itself; re-reading the capture is the independent check.
 */

const REFUND_BASIS_POINTS = 3500; // 35%

type Gate1State = {
  orderId: string | null;
  captureId: string;
  currency: string;
  amount: string;
};

await runGate({
  id: "2",
  title: "partial refund on the gate 1 capture",
  async run(ctx) {
    const state = loadState<Gate1State>("gate1");
    if (state === null || typeof state.captureId !== "string") {
      return {
        ok: false,
        reason: "no capture recorded from gate 1; run gate 1 first",
        qualifier: "BLOCKED",
      };
    }
    ctx.record("capture_id (from gate 1)", state.captureId);

    const totalMinor = toMinor(state.amount, state.currency);
    const { refundMinor, remainingMinor } = splitPartial(totalMinor, REFUND_BASIS_POINTS);
    const refundValue = fromMinor(refundMinor, state.currency);
    ctx.log(
      `refunding ${state.currency} ${refundValue} of ${state.amount}, leaving ${fromMinor(remainingMinor, state.currency)}`,
    );

    const client = new PaypalClient(credentialsFor("seller"), {
      label: "seller",
      log: ctx.log,
      minIntervalMs: 200,
    });

    const res = await client.call({
      method: "POST",
      path: `/v2/payments/captures/${state.captureId}/refund`,
      idempotencySeed: seedOf(["gate2", "refund", state.captureId, ctx.runId]),
      extraHeaders: { Prefer: "return=representation" },
      body: {
        amount: { value: refundValue, currency_code: state.currency },
        note_to_payer: "REHEARSAL gate 2 partial refund",
      },
    });

    const refundId = pick(res.body, ["id"]);
    if (refundId !== null) ctx.record("refund_id", refundId);
    if (res.debugId !== null) ctx.record("paypal_debug_id", res.debugId);

    const verdict = classify({
      httpStatus: res.status,
      body: res.body,
      expect: ["COMPLETED"],
      knownFailed: ["CANCELLED", "FAILED"],
    });
    ctx.log(`refund verdict: ${verdict.kind} (${verdict.detail})`);

    if (verdict.kind !== "success") {
      return {
        ok: false,
        reason: `refund did not complete: http ${res.status}, ${errorSummary(res.body, res.bodyPreview)}`,
        ...(verdict.kind === "unknown" ? { qualifier: "UNKNOWN" } : {}),
      };
    }

    const refundedValue = pick(res.body, ["amount", "value"]);
    if (refundedValue !== refundValue) {
      return {
        ok: false,
        reason: `PayPal refunded ${refundedValue}, we asked for ${refundValue}`,
      };
    }

    // Independent read: does the capture agree it was partially refunded?
    const check = await client.call({
      method: "GET",
      path: `/v2/payments/captures/${state.captureId}`,
    });
    const captureStatus = pick(check.body, ["status"]);
    ctx.log(`capture now reads: ${captureStatus ?? "unreadable"}`);

    if (captureStatus !== "PARTIALLY_REFUNDED") {
      return {
        ok: false,
        reason: `refund reported COMPLETED but the capture reads ${captureStatus ?? "unreadable"}, not PARTIALLY_REFUNDED`,
        qualifier: "UNKNOWN",
      };
    }

    saveState("gate2", { refundId, refundValue, currency: state.currency });

    return {
      ok: true,
      reason: `refunded ${state.currency} ${refundValue} of ${state.amount}; capture confirms PARTIALLY_REFUNDED`,
    };
  },
});
