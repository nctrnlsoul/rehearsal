import { credentialsFor } from "../src/adapters/env";
import { PaypalClient } from "../src/adapters/paypal";
import { seedOf } from "../src/core/idempotency";
import { classify } from "../src/core/outcome";
import { errorSummary, pick, runGate, saveState } from "./_harness";

/**
 * Gate 4: create an invoice, send it, then record it paid, all by API.
 *
 * Both send flags are false on purpose. Sending for real would email a sandbox
 * account, and a gate should not put mail in anyone's inbox to prove a status
 * transition. The invoice still moves to SENT.
 *
 * Gate 0 reported that neither app's token carries an invoicing scope, so a 403
 * here is the expected shape of a capability problem rather than a code bug.
 */

const CURRENCY = "USD";
const AMOUNT = "25.00";

await runGate({
  id: "4",
  title: "invoice sent, then recorded as paid by API",
  async run(ctx) {
    const client = new PaypalClient(credentialsFor("seller"), {
      label: "seller",
      log: ctx.log,
      minIntervalMs: 250,
    });

    const numbered = await client.call({
      method: "POST",
      path: "/v2/invoicing/generate-next-invoice-number",
      idempotencySeed: seedOf(["gate4", "invoice-number", ctx.runId]),
    });

    if (numbered.status === 403 || numbered.status === 401) {
      return {
        ok: false,
        reason: `invoicing refused with http ${numbered.status}: ${errorSummary(numbered.body, numbered.bodyPreview)}. Enable Invoicing on the rehearsal-seller app in the sandbox dashboard.`,
        qualifier: "BLOCKED",
      };
    }
    const invoiceNumber = pick(numbered.body, ["invoice_number"]);
    if (invoiceNumber === null) {
      return {
        ok: false,
        reason: `could not generate an invoice number: http ${numbered.status}, ${errorSummary(numbered.body, numbered.bodyPreview)}`,
        qualifier: "UNKNOWN",
      };
    }
    ctx.record("invoice_number", invoiceNumber);

    const created = await client.call({
      method: "POST",
      path: "/v2/invoicing/invoices",
      idempotencySeed: seedOf(["gate4", "create", ctx.runId]),
      extraHeaders: { Prefer: "return=representation" },
      body: {
        detail: {
          invoice_number: invoiceNumber,
          currency_code: CURRENCY,
          note: "REHEARSAL gate 4 sandbox invoice",
        },
        primary_recipients: [
          {
            billing_info: {
              email_address: `rehearsal-payer-${ctx.runId.slice(-6)}@example.com`,
            },
          },
        ],
        items: [
          {
            name: "REHEARSAL scenario run",
            quantity: "1",
            unit_amount: { currency_code: CURRENCY, value: AMOUNT },
          },
        ],
      },
    });

    const invoiceId = pick(created.body, ["id"]);
    if (invoiceId !== null) ctx.record("invoice_id", invoiceId);
    if (created.debugId !== null) ctx.record("paypal_debug_id", created.debugId);

    const draftVerdict = classify({
      httpStatus: created.status,
      body: created.body,
      expect: ["DRAFT"],
      knownFailed: ["CANCELLED"],
    });
    ctx.log(`draft verdict: ${draftVerdict.kind} (${draftVerdict.detail})`);

    if (draftVerdict.kind !== "success" || invoiceId === null) {
      return {
        ok: false,
        reason: `invoice not created: http ${created.status}, ${errorSummary(created.body, created.bodyPreview)}`,
        ...(draftVerdict.kind === "unknown" ? { qualifier: "UNKNOWN" } : {}),
      };
    }

    const sent = await client.call({
      method: "POST",
      path: `/v2/invoicing/invoices/${invoiceId}/send`,
      idempotencySeed: seedOf(["gate4", "send", invoiceId, ctx.runId]),
      body: { send_to_invoicer: false, send_to_recipient: false },
    });
    ctx.log(`send returned http ${sent.status}`);

    if (sent.status < 200 || sent.status >= 300) {
      return {
        ok: false,
        reason: `send failed: http ${sent.status}, ${errorSummary(sent.body, sent.bodyPreview)}`,
      };
    }

    const afterSend = await client.call({
      method: "GET",
      path: `/v2/invoicing/invoices/${invoiceId}`,
    });
    const sentStatus = pick(afterSend.body, ["status"]);
    ctx.log(`invoice after send: ${sentStatus ?? "unreadable"}`);
    if (sentStatus !== "SENT" && sentStatus !== "UNPAID") {
      return {
        ok: false,
        reason: `invoice reads ${sentStatus ?? "unreadable"} after send, expected SENT`,
        qualifier: "UNKNOWN",
      };
    }

    const paid = await client.call({
      method: "POST",
      path: `/v2/invoicing/invoices/${invoiceId}/payments`,
      idempotencySeed: seedOf(["gate4", "record-payment", invoiceId, ctx.runId]),
      body: {
        method: "BANK_TRANSFER",
        payment_date: new Date().toISOString().slice(0, 10),
        amount: { currency_code: CURRENCY, value: AMOUNT },
        note: "REHEARSAL gate 4 external payment",
      },
    });

    const paymentId = pick(paid.body, ["payment_id"]);
    if (paymentId !== null) ctx.record("invoice_payment_id", paymentId);
    ctx.log(`record-payment returned http ${paid.status}`);

    if (paid.status < 200 || paid.status >= 300) {
      return {
        ok: false,
        reason: `record payment failed: http ${paid.status}, ${errorSummary(paid.body, paid.bodyPreview)}`,
      };
    }

    const afterPay = await client.call({
      method: "GET",
      path: `/v2/invoicing/invoices/${invoiceId}`,
    });
    const finalStatus = pick(afterPay.body, ["status"]);
    ctx.log(`invoice after record-payment: ${finalStatus ?? "unreadable"}`);

    if (finalStatus !== "MARKED_AS_PAID" && finalStatus !== "PAID") {
      return {
        ok: false,
        reason: `invoice reads ${finalStatus ?? "unreadable"} after record-payment, expected MARKED_AS_PAID`,
        qualifier: "UNKNOWN",
      };
    }

    saveState("gate4", { invoiceId, invoiceNumber, paymentId, amount: AMOUNT, currency: CURRENCY });

    return {
      ok: true,
      reason: `invoice ${invoiceNumber} created, sent without email, and recorded ${finalStatus} by API`,
    };
  },
});
