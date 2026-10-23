import type { HandlerRegistry } from "../types";
import { cardOrderHandler } from "./cardOrder";
import { openDisputeHandler } from "./dispute";
import {
  invoiceCancelHandler,
  invoiceCreateHandler,
  invoiceRecordPaymentHandler,
  invoiceSendHandler,
} from "./invoice";
import { payoutBatchHandler } from "./payout";
import { refundHandler } from "./refund";
import { resendWebhookHandler } from "./resendWebhook";

/**
 * One handler per step kind. Typed as a total record, so adding a step kind to
 * the schema without writing its handler is a compile error rather than a
 * surprise halfway through a run.
 */
export const handlers: HandlerRegistry = {
  card_order: cardOrderHandler,
  refund: refundHandler,
  payout_batch: payoutBatchHandler,
  invoice_create: invoiceCreateHandler,
  invoice_send: invoiceSendHandler,
  invoice_record_payment: invoiceRecordPaymentHandler,
  invoice_cancel: invoiceCancelHandler,
  open_dispute: openDisputeHandler,
  resend_webhook: resendWebhookHandler,
};
