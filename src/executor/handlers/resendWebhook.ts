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

/** How long a resend refused as INVALID_RESOURCE_ID is retried, and how often. */
export const RESEND_RETRY_MS = 15_000;
export const RESEND_BUDGET_MS = 120_000;
const MAX_RESEND_ATTEMPTS = Math.floor(RESEND_BUDGET_MS / RESEND_RETRY_MS) + 1;

function errorName(body: unknown): string | null {
  const name = typeof body === "object" && body !== null ? (body as Record<string, unknown>)["name"] : null;
  return typeof name === "string" ? name : null;
}

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

  const ids = { resent_event_id: eventId };
  const resendStarted = ctx.now().getTime();

  for (let attempt = 1; ; attempt += 1) {
    const resend = await ctx.seller.call({
      method: "POST",
      path: `/v1/notifications/webhooks-events/${eventId}/resend`,
      // A fresh request id per attempt, so PayPal cannot replay its cached 404.
      // Only a 404 is ever retried, and a 404 accepted nothing, so a new id
      // cannot cause a second resend.
      idempotencySeed: attempt === 1 ? ctx.seed : ctx.seedFor("resend-attempt", String(attempt)),
      body: { webhook_ids: [webhookId] },
      // Nothing says PayPal dedupes a resend by request id. A timeout or 5xx
      // may already have redelivered, and a replay would deliver a third time.
      replayIfAmbiguous: false,
    });

    if (resend.status >= 200 && resend.status < 300) {
      return succeeded(
        `asked PayPal to redeliver ${step.eventType} ${eventId} to webhook ${webhookId}`,
        ids,
      );
    }

    const summary = `http ${resend.status}, ${errorSummary(resend.body, resend.bodyPreview)}`;
    if (resend.status === 0 || resend.status === 408 || resend.status >= 500) {
      return unknown(
        `resend of ${eventId} may or may not have been accepted (${summary}); not retried, because a retry could deliver it a third time`,
        ids,
      );
    }

    // The event can appear in the list before the resend endpoint accepts its
    // id. That one answer is worth waiting out; every other refusal is final.
    const notYet = resend.status === 404 && errorName(resend.body) === "INVALID_RESOURCE_ID";
    const waited = ctx.now().getTime() - resendStarted;
    if (!notYet || attempt >= MAX_RESEND_ATTEMPTS || waited + RESEND_RETRY_MS > RESEND_BUDGET_MS) {
      return failed(
        notYet
          ? `resend of ${eventId} still refused as INVALID_RESOURCE_ID after ${attempt} attempt(s) over ${Math.round(waited / 1000)}s`
          : `resend of ${eventId} failed: ${summary}`,
        ids,
      );
    }
    ctx.log(`resend of ${eventId} refused as INVALID_RESOURCE_ID, retrying in ${RESEND_RETRY_MS / 1000}s`);
    await ctx.sleep(RESEND_RETRY_MS);
  }
};
