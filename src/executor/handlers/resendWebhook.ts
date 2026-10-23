import { errorSummary } from "../../core/json";
import { type StepHandler, failed, outputOf, succeeded, unknown, wrongKind } from "../types";

/**
 * Asks PayPal to redeliver an event it already sent.
 *
 * This is how a duplicate delivery is produced deliberately. PayPal redelivers
 * in the wild, so an app that does not treat the event id as an idempotency key
 * acts twice, and that is a bug worth finding before a real customer finds it.
 */

const POLL_BUDGET_MS = 120_000;
const POLL_INTERVAL_MS = 8000;
/** Bounds the loop independently of the clock, so a stalled clock cannot hang a run. */
const MAX_POLLS = Math.ceil(POLL_BUDGET_MS / POLL_INTERVAL_MS) + 2;

function eventsOf(body: unknown): Record<string, unknown>[] {
  const holder = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  const raw = holder["events"];
  return Array.isArray(raw)
    ? (raw.filter((e) => typeof e === "object" && e !== null) as Record<string, unknown>[])
    : [];
}

export const resendWebhookHandler: StepHandler = async (ctx) => {
  const step = ctx.step;
  if (step.kind !== "resend_webhook") return wrongKind("resend_webhook", step.kind);

  const webhookId = ctx.meta["webhook_id"];
  if (webhookId === undefined || webhookId.trim() === "") {
    return failed(
      "no webhook is registered for this run, so a resend has nowhere to go; declare a webhook block in the scenario",
    );
  }

  // A card order yields a capture id, a refund yields a refund id. Either is a
  // transaction PayPal can look events up by.
  const transactionId =
    outputOf(ctx, step.from, "capture_id") ?? outputOf(ctx, step.from, "refund_id");
  if (transactionId === null) {
    return unknown(`step ${step.from} recorded no capture_id or refund_id to resend against`);
  }

  const deadline = ctx.now().getTime() + POLL_BUDGET_MS;
  let eventId: string | null = null;
  let lastDetail = "the event list was never read";

  for (let poll = 0; poll < MAX_POLLS && ctx.now().getTime() < deadline; poll += 1) {
    const listed = await ctx.seller.call({
      method: "GET",
      path: `/v1/notifications/webhooks-events?page_size=20&transaction_id=${encodeURIComponent(transactionId)}`,
    });

    // A failed read is never an empty result.
    if (listed.status !== 200) {
      lastDetail = `http ${listed.status}: ${errorSummary(listed.body, listed.bodyPreview)}`;
      ctx.log(`event list FAILED, ${lastDetail}`);
      await ctx.sleep(POLL_INTERVAL_MS);
      continue;
    }

    const matching = eventsOf(listed.body)
      .filter((e) => e["event_type"] === step.eventType)
      .map((e) => ({
        id: typeof e["id"] === "string" ? e["id"] : null,
        at: typeof e["create_time"] === "string" ? e["create_time"] : "",
      }))
      .filter((e): e is { id: string; at: string } => e.id !== null)
      .sort((a, b) => b.at.localeCompare(a.at));

    lastDetail = `${matching.length} ${step.eventType} event(s) for transaction ${transactionId}`;
    ctx.log(lastDetail);
    if (matching.length > 0) {
      eventId = matching[0]!.id;
      break;
    }
    await ctx.sleep(POLL_INTERVAL_MS);
  }

  if (eventId === null) {
    return unknown(
      `no ${step.eventType} event became visible for transaction ${transactionId}: ${lastDetail}`,
    );
  }

  const resend = await ctx.seller.call({
    method: "POST",
    path: `/v1/notifications/webhooks-events/${eventId}/resend`,
    idempotencySeed: ctx.seed,
    body: { webhook_ids: [webhookId] },
  });

  const ids = { resent_event_id: eventId };
  if (resend.status < 200 || resend.status >= 300) {
    return failed(
      `resend of ${eventId} failed: http ${resend.status}, ${errorSummary(resend.body, resend.bodyPreview)}`,
      ids,
    );
  }

  return succeeded(
    `asked PayPal to redeliver ${step.eventType} ${eventId} to webhook ${webhookId}`,
    ids,
  );
};
