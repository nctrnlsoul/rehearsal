import { TRANSPORT_FAILURE } from "../../core/backoff";
import { errorSummary, pick } from "../../core/json";
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

const isoDate = (d: Date) => d.toISOString().slice(0, 10);

/**
 * How a sent invoice's due date reads. The finder decides overdue-invoice from
 * these alone: an unread due date is no evidence either way, so it has its own
 * wording rather than looking like "not overdue".
 */
export const READS_OVERDUE = "reads as overdue";
export const NOT_PAST_DUE = "not past its due date";
export const DUE_DATE_UNREAD = "its due date was unreadable";

/**
 * A lost reply, a 408 or a 5xx may mean PayPal already acted. These invoice
 * writes are not safe to replay on PayPal-Request-Id alone, so such an answer
 * is unknown (a human checks before any retry), never failed, and never resent.
 */
const ambiguous = (status: number): boolean =>
  status === TRANSPORT_FAILURE || status === 408 || status >= 500;

const writeOutcome = (status: number, detail: string, ids: Record<string, string> = {}) =>
  ambiguous(status) ? unknown(detail, ids) : failed(detail, ids);

/**
 * Creates a draft invoice. A negative dueInDays dates the invoice in the past so
 * that once sent it reads as overdue, which is the only way to produce that
 * state: PayPal computes overdue from the due date, there is no API for it.
 */
export const invoiceCreateHandler: StepHandler = async (ctx) => {
  const step = ctx.step;
  if (step.kind !== "invoice_create") return wrongKind("invoice_create", step.kind);
  const currency = ctx.scenario.currency;

  const numbered = await ctx.seller.call({
    method: "POST",
    path: "/v2/invoicing/generate-next-invoice-number",
    idempotencySeed: ctx.seedFor("invoice-number"),
  });
  if (numbered.status === 401 || numbered.status === 403) {
    return failed(
      `invoicing refused with http ${numbered.status}: ${errorSummary(numbered.body, numbered.bodyPreview)}. Enable Invoicing on the rehearsal-seller app.`,
    );
  }
  const invoiceNumber = pick(numbered.body, ["invoice_number"]);
  if (invoiceNumber === null) {
    return unknown(
      `could not generate an invoice number: http ${numbered.status}, ${errorSummary(numbered.body, numbered.bodyPreview)}`,
    );
  }

  const detail: Record<string, unknown> = {
    invoice_number: invoiceNumber,
    currency_code: currency,
    note: `REHEARSAL ${step.id}`,
  };
  if (step.dueInDays !== undefined) {
    const due = new Date(ctx.now().getTime() + step.dueInDays * 86_400_000);
    // PayPal rejects a due date before the invoice date, so a past-due invoice
    // has to be dated on its due date rather than today.
    detail["invoice_date"] = isoDate(step.dueInDays < 0 ? due : ctx.now());
    detail["payment_term"] = { term_type: "DUE_ON_DATE_SPECIFIED", due_date: isoDate(due) };
  }

  const created = await ctx.seller.call({
    method: "POST",
    path: "/v2/invoicing/invoices",
    idempotencySeed: ctx.seedFor("create"),
    extraHeaders: { Prefer: "return=representation" },
    body: {
      detail,
      primary_recipients: [
        { billing_info: { email_address: `rehearsal-payer-${step.id}@example.com` } },
      ],
      items: [
        {
          name: step.itemName ?? `REHEARSAL ${step.id}`,
          quantity: "1",
          unit_amount: { currency_code: currency, value: step.amount },
        },
      ],
    },
  });

  const ids: Record<string, string> = { invoice_number: invoiceNumber };
  const invoiceId = pick(created.body, ["id"]);
  if (invoiceId !== null) ids["invoice_id"] = invoiceId;

  const verdict = classify({
    httpStatus: created.status,
    body: created.body,
    expect: ["DRAFT"],
    knownFailed: ["CANCELLED"],
  });
  if (verdict.kind !== "success" || invoiceId === null) {
    const d = `invoice not created: http ${created.status}, ${errorSummary(created.body, created.bodyPreview)}`;
    return verdict.kind === "failed" ? failed(d, ids) : unknown(d, ids);
  }

  return succeeded(`invoice ${invoiceNumber} created as DRAFT for ${currency} ${step.amount}`, ids);
};

/** Sends with both email flags off: a gate should not put mail in an inbox. */
export const invoiceSendHandler: StepHandler = async (ctx) => {
  const step = ctx.step;
  if (step.kind !== "invoice_send") return wrongKind("invoice_send", step.kind);

  const invoiceId = outputOf(ctx, step.from, "invoice_id");
  if (invoiceId === null) return unknown(`step ${step.from} recorded no invoice_id`);

  const sent = await ctx.seller.call({
    method: "POST",
    path: `/v2/invoicing/invoices/${invoiceId}/send`,
    idempotencySeed: ctx.seed,
    replayIfAmbiguous: false,
    body: { send_to_invoicer: false, send_to_recipient: false },
  });
  if (sent.status < 200 || sent.status >= 300) {
    return writeOutcome(sent.status, `send failed: http ${sent.status}, ${errorSummary(sent.body, sent.bodyPreview)}`);
  }

  const after = await ctx.seller.call({
    method: "GET",
    path: `/v2/invoicing/invoices/${invoiceId}`,
  });
  const status = pick(after.body, ["status"]);
  const dueDate = pick(after.body, ["detail", "payment_term", "due_date"]);
  ctx.log(`invoice reads ${status ?? "unreadable"}${dueDate === null ? "" : `, due ${dueDate}`}`);

  if (status !== "SENT" && status !== "UNPAID") {
    return unknown(`invoice reads ${status ?? "unreadable"} after send, expected SENT or UNPAID`);
  }
  if (dueDate === null) return succeeded(`invoice ${status}; ${DUE_DATE_UNREAD}`);
  if (dueDate < isoDate(ctx.now())) {
    return succeeded(`invoice ${status} and past its due date of ${dueDate}, so it ${READS_OVERDUE}`);
  }
  return succeeded(`invoice ${status}, due ${dueDate}, ${NOT_PAST_DUE}`);
};

export const invoiceRecordPaymentHandler: StepHandler = async (ctx) => {
  const step = ctx.step;
  if (step.kind !== "invoice_record_payment") return wrongKind("invoice_record_payment", step.kind);

  const invoiceId = outputOf(ctx, step.from, "invoice_id");
  if (invoiceId === null) return unknown(`step ${step.from} recorded no invoice_id`);

  const source = findStep(ctx.scenario, step.from);
  if (source === undefined || source.kind !== "invoice_create") {
    return unknown(`step ${step.from} is not an invoice_create step`);
  }
  const amount = step.amount ?? source.amount;

  const paid = await ctx.seller.call({
    method: "POST",
    path: `/v2/invoicing/invoices/${invoiceId}/payments`,
    idempotencySeed: ctx.seed,
    replayIfAmbiguous: false,
    body: {
      method: "BANK_TRANSFER",
      payment_date: isoDate(ctx.now()),
      amount: { currency_code: ctx.scenario.currency, value: amount },
      note: `REHEARSAL ${step.id}`,
    },
  });

  const ids: Record<string, string> = {};
  const paymentId = pick(paid.body, ["payment_id"]);
  if (paymentId !== null) ids["invoice_payment_id"] = paymentId;

  if (paid.status < 200 || paid.status >= 300) {
    return writeOutcome(
      paid.status,
      `record payment failed: http ${paid.status}, ${errorSummary(paid.body, paid.bodyPreview)}`,
      ids,
    );
  }

  const after = await ctx.seller.call({
    method: "GET",
    path: `/v2/invoicing/invoices/${invoiceId}`,
  });
  const status = pick(after.body, ["status"]);
  if (status !== "MARKED_AS_PAID" && status !== "PAID" && status !== "PARTIALLY_PAID") {
    return unknown(`invoice reads ${status ?? "unreadable"} after record-payment`, ids);
  }

  return succeeded(`recorded ${ctx.scenario.currency} ${amount}; invoice reads ${status}`, ids);
};

export const invoiceCancelHandler: StepHandler = async (ctx) => {
  const step = ctx.step;
  if (step.kind !== "invoice_cancel") return wrongKind("invoice_cancel", step.kind);

  const invoiceId = outputOf(ctx, step.from, "invoice_id");
  if (invoiceId === null) return unknown(`step ${step.from} recorded no invoice_id`);

  const cancelled = await ctx.seller.call({
    method: "POST",
    path: `/v2/invoicing/invoices/${invoiceId}/cancel`,
    idempotencySeed: ctx.seed,
    replayIfAmbiguous: false,
    body: {
      subject: "REHEARSAL canceled this invoice",
      note: `Canceled by REHEARSAL step ${step.id}.`,
      send_to_invoicer: false,
      send_to_recipient: false,
    },
  });
  if (cancelled.status < 200 || cancelled.status >= 300) {
    return writeOutcome(
      cancelled.status,
      `cancel failed: http ${cancelled.status}, ${errorSummary(cancelled.body, cancelled.bodyPreview)}`,
    );
  }

  const after = await ctx.seller.call({
    method: "GET",
    path: `/v2/invoicing/invoices/${invoiceId}`,
  });
  const status = pick(after.body, ["status"]);
  if (status !== "CANCELLED") {
    return unknown(`invoice reads ${status ?? "unreadable"} after cancel, expected CANCELLED`);
  }
  return succeeded("invoice CANCELLED");
};
