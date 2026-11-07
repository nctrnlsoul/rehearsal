import { describe, expect, it } from "vitest";
import { requestId } from "../src/core/idempotency";
import { cardOrderHandler } from "../src/executor/handlers/cardOrder";
import { openDisputeHandler } from "../src/executor/handlers/dispute";
import {
  DUE_DATE_UNREAD,
  NOT_PAST_DUE,
  invoiceCancelHandler,
  invoiceCreateHandler,
  invoiceRecordPaymentHandler,
  invoiceSendHandler,
} from "../src/executor/handlers/invoice";
import { payoutBatchHandler } from "../src/executor/handlers/payout";
import { refundHandler } from "../src/executor/handlers/refund";
import {
  RESEND_BUDGET_MS,
  RESEND_RETRY_MS,
  resendWebhookHandler,
} from "../src/executor/handlers/resendWebhook";
import {
  type FakeResponse,
  fakePaypal,
  makeContext,
  makePurchase,
  scenarioWith,
} from "./helpers/fakePaypal";

const orderOk = (amount: string, orderId = "ORD-1", captureId = "CAP-1") => ({
  status: 201,
  body: {
    id: orderId,
    status: "COMPLETED",
    purchase_units: [
      {
        payments: {
          captures: [{ id: captureId, status: "COMPLETED", amount: { currency_code: "USD", value: amount } }],
        },
      },
    ],
  },
});

describe("cardOrderHandler", () => {
  const scenario = scenarioWith([{ id: "o1", kind: "card_order", amount: "42.00" }]);

  it("captures and records both ids", async () => {
    const seller = fakePaypal([orderOk("42.00")]);
    const { ctx } = makeContext({ scenario, stepId: "o1", seller: seller.client });
    const out = await cardOrderHandler(ctx);
    expect(out.kind).toBe("success");
    expect(out.ids).toEqual({ order_id: "ORD-1", capture_id: "CAP-1" });
  });

  // A plan may write "25" where PayPal answers "25.00"; that is the same money,
  // and calling it a failed capture would halt a run that charged correctly.
  it("compares the captured amount as money, not as text", async () => {
    const whole = scenarioWith([{ id: "o1", kind: "card_order", amount: "25" }]);
    const same = fakePaypal([orderOk("25.00")]);
    expect((await cardOrderHandler(makeContext({ scenario: whole, stepId: "o1", seller: same.client }).ctx)).kind).toBe("success");

    const short = fakePaypal([orderOk("24.99")]);
    const out = await cardOrderHandler(makeContext({ scenario: whole, stepId: "o1", seller: short.client }).ctx);
    expect(out.kind).toBe("failed");
    expect(out.detail).toBe("captured 24.99, expected 25");

    const junk = fakePaypal([orderOk("lots")]);
    expect((await cardOrderHandler(makeContext({ scenario: whole, stepId: "o1", seller: junk.client }).ctx)).kind).toBe("failed");
  });

  it("sends a single-step card order with a derived idempotency key", async () => {
    const seller = fakePaypal([orderOk("42.00")]);
    const { ctx } = makeContext({ scenario, stepId: "o1", seller: seller.client });
    await cardOrderHandler(ctx);
    const call = seller.calls[0]!;
    expect(call.method).toBe("POST");
    expect(call.path).toBe("/v2/checkout/orders");
    const body = call.body as Record<string, any>;
    expect(body["intent"]).toBe("CAPTURE");
    expect(body["payment_source"]["card"]["number"]).toBe("4012000033330026");
    expect(body["purchase_units"][0]["amount"]).toEqual({ currency_code: "USD", value: "42.00" });
    expect(requestId("run-test:o1")).toHaveLength(36);
  });

  it("calls an approval requirement a failure, not a payment error", async () => {
    const seller = fakePaypal([
      { status: 200, body: { id: "ORD-1", status: "PAYER_ACTION_REQUIRED", links: [] } },
    ]);
    const { ctx } = makeContext({ scenario, stepId: "o1", seller: seller.client });
    const out = await cardOrderHandler(ctx);
    expect(out.kind).toBe("failed");
    expect(out.detail).toMatch(/browser approval/i);
  });

  it("treats a 5xx as unknown and a 422 as failed", async () => {
    for (const [status, expected] of [
      [500, "unknown"],
      [422, "failed"],
    ] as const) {
      const seller = fakePaypal([{ status, body: { name: "ERR", message: "boom" } }]);
      const { ctx } = makeContext({ scenario, stepId: "o1", seller: seller.client });
      expect((await cardOrderHandler(ctx)).kind, String(status)).toBe(expected);
    }
  });

  it("refuses to call a COMPLETED order with no capture a success", async () => {
    const seller = fakePaypal([{ status: 201, body: { id: "ORD-1", status: "COMPLETED" } }]);
    const { ctx } = makeContext({ scenario, stepId: "o1", seller: seller.client });
    const out = await cardOrderHandler(ctx);
    expect(out.kind).toBe("unknown");
    expect(out.ids).toEqual({ order_id: "ORD-1" });
  });

  it("fails when PayPal captured a different amount", async () => {
    const seller = fakePaypal([orderOk("41.99")]);
    const { ctx } = makeContext({ scenario, stepId: "o1", seller: seller.client });
    const out = await cardOrderHandler(ctx);
    expect(out.kind).toBe("failed");
    expect(out.detail).toContain("41.99");
  });
});

describe("refundHandler", () => {
  const scenario = scenarioWith([
    { id: "o1", kind: "card_order", amount: "40.00" },
    { id: "r1", kind: "refund", from: "o1", mode: "partial", basisPoints: 2500, needs: ["o1"] },
    { id: "r2", kind: "refund", from: "o1", mode: "full", needs: ["o1"] },
  ]);
  const outputs = { o1: { order_id: "ORD-1", capture_id: "CAP-1" } };

  it("refunds 25 percent in exact minor units and confirms on the capture", async () => {
    const seller = fakePaypal([
      { status: 201, body: { id: "REF-1", status: "COMPLETED", amount: { value: "10.00" } } },
      { status: 200, body: { status: "PARTIALLY_REFUNDED" } },
    ]);
    const { ctx } = makeContext({ scenario, stepId: "r1", seller: seller.client, outputs });
    const out = await refundHandler(ctx);
    expect(out.kind).toBe("success");
    expect(out.ids).toEqual({ refund_id: "REF-1" });
    expect((seller.calls[0]!.body as any)["amount"]).toEqual({
      value: "10.00",
      currency_code: "USD",
    });
  });

  it("sends no amount at all for a full refund", async () => {
    const seller = fakePaypal([
      { status: 201, body: { id: "REF-2", status: "COMPLETED" } },
      { status: 200, body: { status: "REFUNDED" } },
    ]);
    const { ctx } = makeContext({ scenario, stepId: "r2", seller: seller.client, outputs });
    const out = await refundHandler(ctx);
    expect(out.kind).toBe("success");
    expect((seller.calls[0]!.body as any)["amount"]).toBeUndefined();
  });

  // The independent check that gate 2 established.
  it("refuses to trust a COMPLETED refund the capture does not confirm", async () => {
    const seller = fakePaypal([
      { status: 201, body: { id: "REF-1", status: "COMPLETED", amount: { value: "10.00" } } },
      { status: 200, body: { status: "COMPLETED" } },
    ]);
    const { ctx } = makeContext({ scenario, stepId: "r1", seller: seller.client, outputs });
    const out = await refundHandler(ctx);
    expect(out.kind).toBe("unknown");
    expect(out.detail).toMatch(/PARTIALLY_REFUNDED/);
  });

  it("fails when PayPal refunded a different amount than asked", async () => {
    const seller = fakePaypal([
      { status: 201, body: { id: "REF-1", status: "COMPLETED", amount: { value: "9.99" } } },
    ]);
    const { ctx } = makeContext({ scenario, stepId: "r1", seller: seller.client, outputs });
    expect((await refundHandler(ctx)).kind).toBe("failed");
  });

  it("stops without a network call when the capture id is missing", async () => {
    const seller = fakePaypal([]);
    const { ctx } = makeContext({ scenario, stepId: "r1", seller: seller.client, outputs: {} });
    const out = await refundHandler(ctx);
    expect(out.kind).toBe("unknown");
    expect(seller.calls).toHaveLength(0);
  });
});

describe("payoutBatchHandler", () => {
  const scenario = scenarioWith([
    { id: "p1", kind: "payout_batch", items: [{ amount: "5.00", unclaimed: true }] },
    { id: "p2", kind: "payout_batch", items: [{ amount: "6.00", unclaimed: false }] },
  ]);

  const accepted = { status: 201, body: { batch_header: { payout_batch_id: "BATCH-1", batch_status: "PENDING" } } };
  const settled = (status: string) => ({
    status: 200,
    body: {
      batch_header: { payout_batch_id: "BATCH-1", batch_status: "PROCESSING" },
      items: [{ payout_item_id: "ITEM-1", transaction_status: status }],
    },
  });

  it("pays a reserved address and accepts UNCLAIMED", async () => {
    const seller = fakePaypal([accepted, settled("UNCLAIMED")]);
    const { ctx } = makeContext({ scenario, stepId: "p1", seller: seller.client });
    const out = await payoutBatchHandler(ctx);
    expect(out.kind).toBe("success");
    expect((out.ids ?? {})["payout_batch_id"]).toBe("BATCH-1");
    const receiver = (seller.calls[0]!.body as any)["items"][0]["receiver"] as string;
    expect(receiver).toMatch(/@example\.com$/);
  });

  it("treats an unclaimed item that settled as a mismatch", async () => {
    const seller = fakePaypal([accepted, settled("SUCCESS")]);
    const { ctx } = makeContext({ scenario, stepId: "p1", seller: seller.client });
    const out = await payoutBatchHandler(ctx);
    expect(out.kind).toBe("failed");
    expect(out.detail).toMatch(/expected UNCLAIMED/);
  });

  it("reports unknown when an item never leaves PENDING", async () => {
    const seller = fakePaypal([accepted, settled("PENDING"), settled("PENDING"), settled("PENDING")]);
    const { ctx } = makeContext({ scenario, stepId: "p1", seller: seller.client });
    const out = await payoutBatchHandler(ctx);
    expect(out.kind).toBe("unknown");
  });

  // Fail closed: never silently redirect real money to a reserved address.
  it("refuses a claimed payout with no configured recipient, before any call", async () => {
    const seller = fakePaypal([]);
    const { ctx } = makeContext({ scenario, stepId: "p2", seller: seller.client });
    const out = await payoutBatchHandler(ctx);
    expect(out.kind).toBe("failed");
    expect(out.detail).toMatch(/REHEARSAL_PAYOUT_RECEIVER/);
    expect(seller.calls).toHaveLength(0);
  });
});

describe("invoice handlers", () => {
  const scenario = scenarioWith([
    { id: "i1", kind: "invoice_create", amount: "25.00", dueInDays: -10 },
    { id: "s1", kind: "invoice_send", from: "i1", needs: ["i1"] },
    { id: "pay1", kind: "invoice_record_payment", from: "i1", needs: ["i1"] },
    { id: "c1", kind: "invoice_cancel", from: "i1", needs: ["i1"] },
  ]);
  const outputs = { i1: { invoice_id: "INV-1", invoice_number: "0007" } };

  it("creates a draft and records the number and id", async () => {
    const seller = fakePaypal([
      { status: 200, body: { invoice_number: "0007" } },
      { status: 201, body: { id: "INV-1", status: "DRAFT" } },
    ]);
    const { ctx } = makeContext({ scenario, stepId: "i1", seller: seller.client });
    const out = await invoiceCreateHandler(ctx);
    expect(out.kind).toBe("success");
    expect(out.ids).toEqual({ invoice_number: "0007", invoice_id: "INV-1" });
  });

  it("dates a past-due invoice on its due date, since PayPal rejects due before invoice date", async () => {
    const seller = fakePaypal([
      { status: 200, body: { invoice_number: "0007" } },
      { status: 201, body: { id: "INV-1", status: "DRAFT" } },
    ]);
    const { ctx } = makeContext({ scenario, stepId: "i1", seller: seller.client });
    await invoiceCreateHandler(ctx);
    const detail = (seller.calls[1]!.body as any)["detail"];
    expect(detail["payment_term"]["due_date"]).toBe("2026-10-13");
    expect(detail["invoice_date"]).toBe("2026-10-13");
  });

  it("reports an invoicing permission problem with the remedy", async () => {
    const seller = fakePaypal([{ status: 403, body: { name: "NOT_AUTHORIZED" } }]);
    const { ctx } = makeContext({ scenario, stepId: "i1", seller: seller.client });
    const out = await invoiceCreateHandler(ctx);
    expect(out.kind).toBe("failed");
    expect(out.detail).toMatch(/Enable Invoicing/);
  });

  it("sends with both email flags off and notes an overdue invoice", async () => {
    const seller = fakePaypal([
      { status: 200 },
      { status: 200, body: { status: "UNPAID", detail: { payment_term: { due_date: "2026-10-13" } } } },
    ]);
    const { ctx } = makeContext({ scenario, stepId: "s1", seller: seller.client, outputs });
    const out = await invoiceSendHandler(ctx);
    expect(out.kind).toBe("success");
    expect(out.detail).toMatch(/overdue/i);
    expect(seller.calls[0]!.body).toEqual({ send_to_invoicer: false, send_to_recipient: false });
  });

  // The finder reads these two apart: "not past due" is a finding, an unread
  // due date is no evidence at all.
  it("says when the due date is not past, and when it could not be read", async () => {
    const future = fakePaypal([
      { status: 200 },
      { status: 200, body: { status: "UNPAID", detail: { payment_term: { due_date: "2999-01-01" } } } },
    ]);
    const a = await invoiceSendHandler(makeContext({ scenario, stepId: "s1", seller: future.client, outputs }).ctx);
    expect(a.kind).toBe("success");
    expect(a.detail).toBe(`invoice UNPAID, due 2999-01-01, ${NOT_PAST_DUE}`);

    const blind = fakePaypal([{ status: 200 }, { status: 200, body: { status: "UNPAID" } }]);
    const b = await invoiceSendHandler(makeContext({ scenario, stepId: "s1", seller: blind.client, outputs }).ctx);
    expect(b.detail).toBe(`invoice UNPAID; ${DUE_DATE_UNREAD}`);
    expect(b.detail).not.toContain(NOT_PAST_DUE);
  });

  // A lost reply, 408 or 5xx may mean PayPal already sent, recorded or
  // canceled. Resending could record a second payment, so these stop as
  // unknown after one call; a clear refusal is still a plain failure.
  it("treats an ambiguous answer to an invoice write as unknown and never resends it", async () => {
    const handlerFor = { s1: invoiceSendHandler, pay1: invoiceRecordPaymentHandler, c1: invoiceCancelHandler } as const;
    for (const [stepId, handler] of Object.entries(handlerFor)) {
      for (const status of [503, 500, 408, 409]) {
        const seller = fakePaypal([{ status }]);
        const out = await handler(makeContext({ scenario, stepId, seller: seller.client, outputs }).ctx);
        expect(out.kind, `${stepId} ${status}`).toBe("unknown");
        expect(seller.calls, `${stepId} ${status}`).toHaveLength(1);
      }
      const refused = fakePaypal([{ status: 422, body: { name: "UNPROCESSABLE_ENTITY" } }]);
      expect((await handler(makeContext({ scenario, stepId, seller: refused.client, outputs }).ctx)).kind).toBe("failed");
    }
  });

  it("records a payment and confirms the invoice status", async () => {
    const seller = fakePaypal([
      { status: 200, body: { payment_id: "EXTR-1" } },
      { status: 200, body: { status: "MARKED_AS_PAID" } },
    ]);
    const { ctx } = makeContext({ scenario, stepId: "pay1", seller: seller.client, outputs });
    const out = await invoiceRecordPaymentHandler(ctx);
    expect(out.kind).toBe("success");
    expect(out.ids).toEqual({ invoice_payment_id: "EXTR-1" });
    expect((seller.calls[0]!.body as any)["amount"]).toEqual({ currency_code: "USD", value: "25.00" });
  });

  it("cancels and refuses any status other than CANCELLED", async () => {
    const good = fakePaypal([{ status: 204 }, { status: 200, body: { status: "CANCELLED" } }]);
    const a = makeContext({ scenario, stepId: "c1", seller: good.client, outputs });
    expect((await invoiceCancelHandler(a.ctx)).kind).toBe("success");
    // The note is sent to PayPal and shown there, so it is in US spelling (R-033).
    const sent = good.calls[0]!.body as Record<string, string>;
    expect(sent["subject"]).toBe("REHEARSAL canceled this invoice");
    expect(sent["note"]).toBe("Canceled by REHEARSAL step c1.");

    const bad = fakePaypal([{ status: 204 }, { status: 200, body: { status: "SENT" } }]);
    const b = makeContext({ scenario, stepId: "c1", seller: bad.client, outputs });
    expect((await invoiceCancelHandler(b.ctx)).kind).toBe("unknown");
  });
});

describe("resendWebhookHandler", () => {
  const scenario = scenarioWith([
    { id: "o1", kind: "card_order", amount: "40.00" },
    {
      id: "dup",
      kind: "resend_webhook",
      from: "o1",
      eventType: "PAYMENT.CAPTURE.COMPLETED",
      needs: ["o1"],
    },
  ]);
  const outputs = { o1: { order_id: "ORD-1", capture_id: "CAP-1" } };
  const listed = (events: unknown[]) => ({ status: 200, body: { events } });
  const theEvent = {
    id: "WH-1",
    event_type: "PAYMENT.CAPTURE.COMPLETED",
    create_time: "2026-10-23T12:00:00Z",
  };

  it("finds the event by transaction id and resends it to the run's webhook", async () => {
    const seller = fakePaypal([listed([theEvent]), { status: 202 }]);
    const { ctx } = makeContext({
      scenario,
      stepId: "dup",
      seller: seller.client,
      outputs,
      meta: { webhook_id: "WH-REG-1" },
    });
    const out = await resendWebhookHandler(ctx);
    expect(out.kind).toBe("success");
    expect((out.ids ?? {})["resent_event_id"]).toBe("WH-1");
    expect(decodeURIComponent(seller.calls[0]!.path)).toContain("transaction_id=CAP-1");
    expect(seller.calls[1]!.path).toBe("/v1/notifications/webhooks-events/WH-1/resend");
    expect(seller.calls[1]!.body).toEqual({ webhook_ids: ["WH-REG-1"] });
  });

  it("ignores events of other types for the same transaction", async () => {
    const seller = fakePaypal([
      listed([{ ...theEvent, id: "WH-OTHER", event_type: "PAYMENT.CAPTURE.REFUNDED" }, theEvent]),
      { status: 202 },
    ]);
    const { ctx } = makeContext({
      scenario,
      stepId: "dup",
      seller: seller.client,
      outputs,
      meta: { webhook_id: "WH-REG-1" },
    });
    await resendWebhookHandler(ctx);
    expect(seller.calls[1]!.path).toContain("WH-1");
  });

  // A resend with nowhere to go would look like a success and deliver nothing.
  it("fails without a registered webhook, before any call", async () => {
    const seller = fakePaypal([]);
    const { ctx } = makeContext({ scenario, stepId: "dup", seller: seller.client, outputs });
    const out = await resendWebhookHandler(ctx);
    expect(out.kind).toBe("failed");
    expect(out.detail).toMatch(/nowhere to go/i);
    expect(seller.calls).toHaveLength(0);
  });

  it("stops without a call when the referenced step recorded no transaction id", async () => {
    const seller = fakePaypal([]);
    const { ctx } = makeContext({
      scenario,
      stepId: "dup",
      seller: seller.client,
      outputs: {},
      meta: { webhook_id: "WH-REG-1" },
    });
    expect((await resendWebhookHandler(ctx)).kind).toBe("unknown");
    expect(seller.calls).toHaveLength(0);
  });

  it("reports unknown when no matching event ever appears", async () => {
    const seller = fakePaypal(Array.from({ length: 20 }, () => listed([])));
    const { ctx } = makeContext({
      scenario,
      stepId: "dup",
      seller: seller.client,
      outputs,
      meta: { webhook_id: "WH-REG-1" },
    });
    const out = await resendWebhookHandler(ctx);
    expect(out.kind).toBe("unknown");
    expect(out.detail).toMatch(/never became visible|0 PAYMENT/i);
  });

  // A failed read must never read as "no such event".
  it("does not treat a failed event list as an empty one", async () => {
    const seller = fakePaypal([
      { status: 400, body: { name: "VALIDATION_ERROR" } },
      listed([theEvent]),
      { status: 202 },
    ]);
    const { ctx } = makeContext({
      scenario,
      stepId: "dup",
      seller: seller.client,
      outputs,
      meta: { webhook_id: "WH-REG-1" },
    });
    const out = await resendWebhookHandler(ctx);
    expect(out.kind).toBe("success");
  });

  it("fails when PayPal refuses the resend", async () => {
    const seller = fakePaypal([listed([theEvent]), { status: 422, body: { name: "NOPE" } }]);
    const { ctx } = makeContext({
      scenario,
      stepId: "dup",
      seller: seller.client,
      outputs,
      meta: { webhook_id: "WH-REG-1" },
    });
    expect((await resendWebhookHandler(ctx)).kind).toBe("failed");
  });

  describe("retrying a resend", () => {
    const notYet = { status: 404, body: { name: "INVALID_RESOURCE_ID", message: "Resource id is invalid" } };
    const run = (queue: FakeResponse[]) => {
      const seller = fakePaypal([listed([theEvent]), ...queue]);
      const made = makeContext({
        scenario,
        stepId: "dup",
        seller: seller.client,
        outputs,
        meta: { webhook_id: "WH-REG-1" },
      });
      const resends = () => seller.calls.filter((c) => c.path.endsWith("/resend"));
      return { seller, ...made, resends };
    };

    // Seen live on 2026-10-23: the event was listed, then the resend 404ed.
    it("waits out INVALID_RESOURCE_ID every 15s and succeeds once PayPal accepts", async () => {
      const r = run([notYet, notYet, { status: 202 }]);
      const out = await resendWebhookHandler(r.ctx);
      expect(out.kind).toBe("success");
      expect(r.resends()).toHaveLength(3);
      expect(r.sleeps).toEqual([RESEND_RETRY_MS, RESEND_RETRY_MS]);
      // A fresh request id each time, so PayPal cannot replay its cached 404.
      const ids = r.resends().map((c) => c.headers["PayPal-Request-Id"]);
      expect(new Set(ids).size).toBe(3);
    });

    it("gives up after two minutes and fails, so the finder reports inconclusive", async () => {
      const r = run(Array.from({ length: 20 }, () => notYet));
      const out = await resendWebhookHandler(r.ctx);
      expect(out.kind).toBe("failed");
      expect(out.detail).toMatch(/still refused as INVALID_RESOURCE_ID after 9 attempt\(s\) over 120s/);
      expect(r.resends()).toHaveLength(9);
      expect(r.sleeps.reduce((a, b) => a + b, 0)).toBe(RESEND_BUDGET_MS);
    });

    it("does not retry any other 404", async () => {
      const r = run([{ status: 404, body: { name: "RESOURCE_NOT_FOUND" } }, { status: 202 }]);
      expect((await resendWebhookHandler(r.ctx)).kind).toBe("failed");
      expect(r.resends()).toHaveLength(1);
    });

    // PayPal may have redelivered already; a retry could deliver a third time.
    it("never retries a 5xx or 408, and reports the outcome as unknown", async () => {
      for (const status of [500, 503, 408]) {
        const r = run([{ status }, { status: 202 }]);
        const out = await resendWebhookHandler(r.ctx);
        expect(out.kind, String(status)).toBe("unknown");
        expect(out.detail).toMatch(/could deliver it a third time/);
        expect(r.resends(), String(status)).toHaveLength(1);
      }
    });

    it("never retries a timeout", async () => {
      // Nothing queued after the list read, so the resend's fetch throws.
      const r = run([]);
      const out = await resendWebhookHandler(r.ctx);
      expect(out.kind).toBe("unknown");
      expect(r.resends()).toHaveLength(1);
    });
  });
});

describe("openDisputeHandler", () => {
  const scenario = scenarioWith([{ id: "d1", kind: "open_dispute" }]);

  const created201 = {
    status: 201,
    body: {
      links: [
        { href: "https://api-m.sandbox.paypal.com/v1/customer/disputes/PP-R-DXC-1", rel: "self", method: "GET" },
      ],
    },
  };

  it("files against a banked purchase and reads the id out of the self link", async () => {
    const buyer = fakePaypal([created201], "buyer");
    const seller = fakePaypal(
      [{ status: 200, body: { status: "WAITING_FOR_SELLER_RESPONSE", dispute_life_cycle_stage: "INQUIRY" } }],
      "seller",
    );
    const { ctx } = makeContext({
      scenario,
      stepId: "d1",
      seller: seller.client,
      buyer: buyer.client,
      claim: { ok: true, purchase: makePurchase() },
    });
    const out = await openDisputeHandler(ctx);
    expect(out.kind).toBe("success");
    expect((out.ids ?? {})["dispute_id"]).toBe("PP-R-DXC-1");
    expect((out.ids ?? {})["buyer_transaction_id"]).toBe("TXN-BANK-1");
    expect(out.detail).toMatch(/WAITING_FOR_SELLER_RESPONSE/);
  });

  it("sends the buyer-side transaction id, never the capture id", async () => {
    const buyer = fakePaypal([created201], "buyer");
    const seller = fakePaypal([{ status: 200, body: { status: "OPEN" } }], "seller");
    const { ctx } = makeContext({
      scenario,
      stepId: "d1",
      seller: seller.client,
      buyer: buyer.client,
      claim: { ok: true, purchase: makePurchase() },
    });
    await openDisputeHandler(ctx);
    const body = buyer.calls[0]!.body as any;
    expect(body["disputed_transactions"]).toEqual([{ buyer_transaction_id: "TXN-BANK-1" }]);
    expect(JSON.stringify(body)).not.toContain("CAP-BANK-1");
    expect(body["extensions"]["merchant_contacted_outcome"]).toBe("NO_RESPONSE");
  });

  // Fail closed: an empty bank stops the step rather than skipping it.
  it("fails with the bank's own message when no purchase is available", async () => {
    const seller = fakePaypal([]);
    const { ctx } = makeContext({ scenario, stepId: "d1", seller: seller.client });
    const out = await openDisputeHandler(ctx);
    expect(out.kind).toBe("failed");
    expect(out.detail).toMatch(/bank is empty/i);
    expect(seller.calls).toHaveLength(0);
  });

  it("refuses a banked purchase in a different currency", async () => {
    const seller = fakePaypal([]);
    const { ctx } = makeContext({
      scenario,
      stepId: "d1",
      seller: seller.client,
      claim: { ok: true, purchase: makePurchase({ currency: "EUR" }) },
    });
    const out = await openDisputeHandler(ctx);
    expect(out.kind).toBe("failed");
    expect(out.detail).toMatch(/EUR/);
  });

  it("fails on a 400 from dispute creation", async () => {
    const buyer = fakePaypal([{ status: 400, body: { name: "INVALID_REQUEST", details: [{ issue: "TRANSACTION_NOT_ELIGIBLE" }] } }], "buyer");
    const seller = fakePaypal([], "seller");
    const { ctx } = makeContext({
      scenario,
      stepId: "d1",
      seller: seller.client,
      buyer: buyer.client,
      claim: { ok: true, purchase: makePurchase() },
    });
    const out = await openDisputeHandler(ctx);
    expect(out.kind).toBe("failed");
    expect(out.detail).toMatch(/TRANSACTION_NOT_ELIGIBLE/);
  });

  it("calls a created but still settling dispute a success, since the write landed", async () => {
    const buyer = fakePaypal([created201], "buyer");
    const seller = fakePaypal(
      Array.from({ length: 20 }, () => ({ status: 200, body: { status: "CREATION_IN_PROGRESS" } })),
      "seller",
    );
    const { ctx } = makeContext({
      scenario,
      stepId: "d1",
      seller: seller.client,
      buyer: buyer.client,
      claim: { ok: true, purchase: makePurchase() },
    });
    const out = await openDisputeHandler(ctx);
    expect(out.kind).toBe("success");
    expect(out.detail).toMatch(/still settling/i);
    expect((out.ids ?? {})["dispute_id"]).toBe("PP-R-DXC-1");
  });
});
