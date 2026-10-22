import { credentialsFor } from "../src/adapters/env";
import { PaypalClient } from "../src/adapters/paypal";
import { seedOf } from "../src/core/idempotency";
import { toMinor } from "../src/core/money";
import { classify } from "../src/core/outcome";
import { errorSummary, pick, runGate, saveState } from "./_harness";

/**
 * Gate 1: can our code take a card payment with no human in the loop?
 *
 * Single-step Orders v2: intent CAPTURE plus payment_source.card means PayPal
 * processes the card on the create call, so there is no separate capture request
 * and no approval redirect. If this gate fails on eligibility rather than on our
 * code, that is the finding the scope decision needs.
 */

const CURRENCY = "USD";
const AMOUNT = "42.00";

// Published PayPal sandbox test Visa, from developer.paypal.com's card-testing
// page. A test value, not a secret, so it belongs in the repo.
const CARD = {
  number: "4012000033330026",
  expiry: "2030-01",
  security_code: "123",
  name: "Rehearsal Gate",
  billing_address: {
    address_line_1: "1 Test Street",
    admin_area_2: "San Jose",
    admin_area_1: "CA",
    postal_code: "95131",
    country_code: "US",
  },
};

await runGate({
  id: "1",
  title: "card order captured by API alone (single-step Orders v2)",
  async run(ctx) {
    const client = new PaypalClient(credentialsFor("seller"), {
      label: "seller",
      log: ctx.log,
      minIntervalMs: 200,
    });

    const res = await client.call({
      method: "POST",
      path: "/v2/checkout/orders",
      idempotencySeed: seedOf(["gate1", "create-order", ctx.runId]),
      // Without this the response is a bare id and status, and the capture id
      // we need for gate 2 never arrives.
      extraHeaders: { Prefer: "return=representation" },
      body: {
        intent: "CAPTURE",
        purchase_units: [
          {
            reference_id: "rehearsal-gate-1",
            description: "REHEARSAL sample store, gate 1",
            amount: { currency_code: CURRENCY, value: AMOUNT },
          },
        ],
        payment_source: { card: CARD },
      },
    });

    const orderId = pick(res.body, ["id"]);
    if (orderId !== null) ctx.record("order_id", orderId);
    if (res.debugId !== null) ctx.record("paypal_debug_id", res.debugId);

    const orderVerdict = classify({
      httpStatus: res.status,
      body: res.body,
      expect: ["COMPLETED"],
      knownFailed: ["VOIDED"],
    });
    ctx.log(`order verdict: ${orderVerdict.kind} (${orderVerdict.detail})`);

    const orderStatus = pick(res.body, ["status"]);

    // 3DS or wallet approval needed. That is a human step, not a code failure,
    // and it is exactly what the scope decision turns on.
    if (orderStatus === "PAYER_ACTION_REQUIRED") {
      const link = Array.isArray((res.body as { links?: unknown }).links)
        ? ((res.body as { links: Array<Record<string, unknown>> }).links.find(
            (l) => l["rel"] === "payer-action",
          )?.["href"] as string | undefined)
        : undefined;
      if (link !== undefined) ctx.note(`approval URL: ${link}`);
      return {
        ok: false,
        reason: "card order needs a human approval step, so API-alone capture is not available",
        qualifier: "BLOCKED",
      };
    }

    if (orderVerdict.kind !== "success") {
      return {
        ok: false,
        reason: `order did not complete: http ${res.status}, ${errorSummary(res.body, res.bodyPreview)}`,
        ...(orderVerdict.kind === "unknown" ? { qualifier: "UNKNOWN" } : {}),
      };
    }

    const captureId = pick(res.body, ["purchase_units", 0, "payments", "captures", 0, "id"]);
    const captureStatus = pick(res.body, [
      "purchase_units",
      0,
      "payments",
      "captures",
      0,
      "status",
    ]);
    const capturedValue = pick(res.body, [
      "purchase_units",
      0,
      "payments",
      "captures",
      0,
      "amount",
      "value",
    ]);
    const capturedCurrency = pick(res.body, [
      "purchase_units",
      0,
      "payments",
      "captures",
      0,
      "amount",
      "currency_code",
    ]);

    if (captureId === null || captureStatus === null) {
      return {
        ok: false,
        reason: "order reported COMPLETED but carried no capture id, so nothing is proven",
        qualifier: "UNKNOWN",
      };
    }
    ctx.record("capture_id", captureId);

    if (captureStatus !== "COMPLETED") {
      return {
        ok: false,
        reason: `capture status is ${captureStatus}, not COMPLETED`,
        qualifier: "UNKNOWN",
      };
    }
    if (capturedValue !== AMOUNT || capturedCurrency !== CURRENCY) {
      return {
        ok: false,
        reason: `captured ${capturedCurrency} ${capturedValue}, expected ${CURRENCY} ${AMOUNT}`,
      };
    }

    saveState("gate1", {
      orderId,
      captureId,
      currency: CURRENCY,
      amount: AMOUNT,
      amountMinor: toMinor(AMOUNT, CURRENCY).toString(),
      runId: ctx.runId,
    });

    return {
      ok: true,
      reason: `card captured ${CURRENCY} ${AMOUNT} by API alone, no human step, no separate capture call`,
    };
  },
});
