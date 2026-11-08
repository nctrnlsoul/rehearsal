import { type RunStory, type StepCard, dur, expectsReply } from "./runStory";

export { expectsReply };

/**
 * The "Now running" panel: the one thing happening in a run right now, from
 * the same RunStory the page draws. Pure, so every state is tested without a
 * browser. Each figure moves only when the story does: nothing here estimates,
 * eases or fills ahead of what PayPal and the store have actually said.
 */

export type StageState = "done" | "now" | "todo" | "none" | "bad" | "unknown";
export type Stage = { readonly label: string; readonly short: string; readonly state: StageState };

/** One segment per step: sent is PayPal accepting the call, confirmed its events all arriving verified. */
export type Segment = { readonly n: number; readonly sent: boolean; readonly confirmed: boolean; readonly expects: boolean; readonly failed: boolean };

export type Chip = { readonly key: string; readonly label: string; readonly state: "in" | "out" | "bad" };

export type PanelBody =
  | { readonly kind: "queued"; readonly title: string; readonly text: string }
  | { readonly kind: "step"; readonly at: number; readonly of: number; readonly activity: string; readonly stages: readonly Stage[] }
  | { readonly kind: "webhooks"; readonly title: string; readonly text: string | null; readonly chips: readonly Chip[] }
  | { readonly kind: "final"; readonly tone: "done" | "stopped"; readonly title: string; readonly text: string | null; readonly note: string | null; readonly chips: readonly Chip[] };

export type NowPanel = {
  /** Changes only when the box should swap its content: a new step, the wait, the end. */
  readonly key: string;
  readonly sticky: boolean;
  readonly segments: readonly Segment[];
  readonly label: string;
  readonly body: PanelBody;
};

const FAILED = new Set(["refused", "not-sent", "unknown", "never-confirmed"]);

/** What a step is doing while it is being sent, in the words of the brief's example. */
const DOING: Readonly<Record<string, string>> = {
  card_order: "Capturing a card payment",
  payout_batch: "Sending a payout",
  invoice_create: "Creating the invoice",
  invoice_send: "Sending the invoice",
  invoice_record_payment: "Recording the invoice payment",
  invoice_cancel: "Canceling the invoice",
  open_dispute: "Opening a dispute",
  resend_webhook: "Asking PayPal to resend an event",
};

/** Short names for an expected event's chip. */
const CHIP_WORD: Readonly<Record<string, string>> = {
  "PAYMENT.CAPTURE.COMPLETED": "payment",
  "PAYMENT.CAPTURE.REFUNDED": "refund",
  "CHECKOUT.ORDER.APPROVED": "order",
  "CHECKOUT.ORDER.COMPLETED": "order",
  "INVOICING.INVOICE.CREATED": "invoice",
  "INVOICING.INVOICE.PAID": "invoice paid",
  "CUSTOMER.DISPUTE.CREATED": "dispute",
};

const verifiedReply = (c: StepCard) => c.replies.length > 0 && c.replies.every((r) => r.arrived && r.copies > 0 && r.verified === r.copies);

function chipsOf(cards: readonly StepCard[]): Chip[] {
  return cards.flatMap((c) =>
    c.replies.map((r): Chip => ({
      key: r.key,
      label: `Step ${c.n} ${r.redelivery ? "resend" : (CHIP_WORD[r.eventType] ?? "event")}`,
      state: !r.arrived ? "out" : r.copies > 0 && r.verified === r.copies ? "in" : "bad",
    })),
  );
}

export function stagesOf(c: StepCard): Stage[] {
  const failed = FAILED.has(c.sent);
  const accepted = c.sent === "accepted";
  // Nobody can prove whether PayPal took the call, so neither stage claims it did or did not.
  if (c.sent === "unknown" || c.sent === "never-confirmed") {
    return [
      { label: "Sending to PayPal", short: "Sending", state: "unknown" },
      { label: "Outcome unknown", short: "Unknown", state: "unknown" },
      { label: "Waiting for PayPal's webhook", short: "Webhook", state: "todo" },
      { label: "Signature verified", short: "Verified", state: "todo" },
    ];
  }
  const expects = expectsReply(c);
  const arrived = c.replies.length > 0 && c.replies.every((r) => r.arrived);
  return [
    { label: "Sending to PayPal", short: "Sending", state: c.sent === "sending" ? "now" : accepted || c.sent === "refused" ? "done" : failed ? "bad" : "todo" },
    { label: c.sent === "refused" ? "PayPal refused" : "PayPal accepted", short: c.sent === "refused" ? "Refused" : "Accepted", state: accepted ? "done" : failed ? "bad" : "todo" },
    !expects
      ? { label: "No webhook expected", short: "No webhook", state: "none" }
      : arrived
        ? { label: "Webhook arrived", short: "Arrived", state: "done" }
        : { label: "Waiting for PayPal's webhook", short: "Webhook", state: accepted && (c.reply === "waiting" || c.reply === "not-yet") ? "now" : "todo" },
    !expects
      ? { label: "Nothing to verify", short: "No check", state: "none" }
      : { label: "Signature verified", short: "Verified", state: verifiedReply(c) ? "done" : arrived ? "bad" : "todo" },
  ];
}

function activityOf(c: StepCard): string {
  const base = c.sent === "sending" ? (c.kind === "refund" ? c.title.replace(/^Send /, "Sending ") : (DOING[c.kind] ?? c.title)) : c.title;
  return c.amount === null ? base : `${base}, ${c.amount}`;
}

export function nowPanel(story: RunStory): NowPanel {
  const cards = story.cards;
  const total = cards.length;
  const segments: Segment[] = cards.map((c) => {
    const expects = expectsReply(c);
    return { n: c.n, sent: c.sent === "accepted", confirmed: c.sent === "accepted" && expects && verifiedReply(c), expects, failed: FAILED.has(c.sent) };
  });
  const sent = segments.filter((s) => s.sent).length;
  const chips = chipsOf(cards);
  const replies = cards.flatMap((c) => c.replies);
  // The story's own count, so the bar, the hero and the proof strip never disagree.
  const { expected, arrived, verified } = story.counts;
  const label = `${sent} of ${total} accepted${expected === 0 ? "" : `, ${verified} of ${expected} verified`}`;
  const base = { sticky: !story.settled, segments, label };

  if (story.tone === "queued") return { ...base, key: "queued", body: { kind: "queued", title: "Queued", text: "Waiting for the server to start it." } };
  // Started, but the plan note that names the steps has not been read yet.
  if (total === 0 && !story.settled) return { ...base, key: "queued", body: { kind: "queued", title: "Starting", text: "The server has picked it up. The first step starts in a moment." } };

  if (story.tone === "stopped" || story.settled) {
    // The reason is the hero's lead, just above; said once there, never again here.
    if (story.tone === "stopped") return { ...base, key: "final", body: { kind: "final", tone: "stopped", title: story.headline, text: null, note: null, chips: story.settled ? [] : chips } };
    const others = story.other.length;
    const note =
      [story.outOfOrder, others === 0 ? null : `PayPal also sent ${others} ${others === 1 ? "event" : "events"} not tied to a step by this console, listed below under Other events.`]
        .filter((x) => x !== null)
        .join(" ") || null;
    const hooks = (n: number) => `${n} ${n === 1 ? "webhook" : "webhooks"}`;
    const text =
      expected === 0
        ? "No webhook is tied to these steps."
        : arrived === expected && verified === arrived
          ? `${verified} of ${hooks(expected)} arrived, all verified.`
          : `${arrived} of ${hooks(expected)} arrived before the run ended, ${verified} verified.`;
    // The sentence already says every webhook was verified; chips stay only to show which one was not.
    return { ...base, key: "final", body: { kind: "final", tone: "done", title: story.headline, text, note, chips: chips.every((c) => c.state === "in") ? [] : chips } };
  }

  const current = cards.find((c) => c.sent === "sending");
  const next = cards.find((c) => c.sent === "queued");
  if (current !== undefined || next !== undefined) {
    // Between two calls the step PayPal just accepted stays in the box until the next one starts.
    const lastAccepted = next === undefined ? undefined : [...cards].reverse().find((c) => c.n < next.n && c.sent === "accepted");
    const c = current ?? lastAccepted ?? next!;
    return { ...base, key: `step:${c.id}`, body: { kind: "step", at: c.n, of: total, activity: activityOf(c), stages: stagesOf(c) } };
  }

  // Every call is done; what is left is PayPal's webhooks.
  const left = story.view.waitLeftS;
  const listening = left === null ? null : `The run keeps listening for ${dur(left)} in case PayPal sends more.`;
  if (replies.length === 0) {
    return { ...base, key: "webhooks", body: { kind: "webhooks", title: `All ${total} ${total === 1 ? "step" : "steps"} sent`, text: `No webhook is tied to these steps.${listening === null ? "" : ` ${listening}`}`, chips } };
  }
  return {
    ...base,
    key: "webhooks",
    body:
      arrived < expected
        ? { kind: "webhooks", title: `Waiting for PayPal's webhooks: ${arrived} of ${expected} arrived`, text: story.outOfOrder ?? "Each one turns to a check when it arrives and its signature is verified.", chips }
        : { kind: "webhooks", title: `All ${expected} webhooks arrived, ${verified} verified`, text: [story.outOfOrder, listening].filter((x) => x !== null).join(" ") || null, chips },
  };
}
