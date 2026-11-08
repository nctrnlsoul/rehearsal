import { type LiveRead, type LiveView, liveView } from "./liveView";

/**
 * The run page in plain English, from one poll of a live run or one moment of
 * a replay. Pure, so every state is tested without a browser. liveView does
 * the exact joining of calls to deliveries; this decides what each step card
 * and the hero say about them. Raw names (step kinds, event types, PayPal's
 * own detail) stay available for the Details panels, never in the headline.
 */

export type SentState = "queued" | "not-run" | "sending" | "accepted" | "refused" | "not-sent" | "unknown" | "never-confirmed";
export type ReplyState = "none-expected" | "not-yet" | "waiting" | "delivered" | "not-seen" | "none";

export type Reply = {
  readonly key: string;
  readonly eventId: string | null;
  readonly eventType: string;
  /** "Payment completed". */
  readonly plain: string;
  readonly arrived: boolean;
  readonly latencyS: number | null;
  /** True when the latency runs to the store's own receive time. */
  readonly exact: boolean;
  /** The store recorded it before the step finished, while the step was still checking with PayPal. */
  readonly early: boolean;
  /** 1 for the first event this run saw arrive, and so on; null while waiting. */
  readonly rank: number | null;
  readonly receivedAt: string | null;
  /** Copies the store verified as PayPal's, of all copies it recorded. */
  readonly verified: number;
  readonly copies: number;
  readonly store: string | null;
  readonly redelivery: boolean;
};

export type StepCard = {
  readonly id: string;
  readonly n: number;
  readonly kind: string;
  readonly title: string;
  readonly amount: string | null;
  readonly sent: SentState;
  readonly sentWord: string;
  readonly reply: ReplyState;
  readonly replies: readonly Reply[];
  /** Seconds the oldest unanswered reply has waited, while it waits. */
  readonly waitingS: number | null;
  readonly current: boolean;
  /** A human sentence for a step that did not succeed. */
  readonly problem: string | null;
  /** Seconds since a slow step started, while PayPal works on it; null otherwise. */
  readonly sendingS: number | null;
  /** One plain line on why a slow step takes this long, while it is being sent. */
  readonly sendingNote: string | null;
  /** The engine's pairing_mismatch line: PayPal ties the dispute to another capture than the bank. */
  readonly pairing: string | null;
  /** What is known about an expected event that was not seen, beyond the general line. */
  readonly lateNote: string | null;
  readonly details: {
    readonly kind: string;
    readonly request: string | null;
    readonly ids: ReadonlyArray<readonly [string, string]>;
    readonly startedAt: string | null;
    readonly acceptedAt: string | null;
    readonly detail: string | null;
    readonly paypalCode: string | null;
    readonly from: string | null;
  };
};

/** step: the step whose call the event is tied to, so the strip can say "Step 2, payment". */
export type ProofNode = { readonly key: string; readonly step: number | null; readonly label: string; readonly arrived: boolean; readonly latencyS: number | null; readonly exact: boolean; readonly early: boolean; readonly verified: boolean };

/**
 * An event no step is known to cause. related: a step whose own ids include
 * an id the store recorded for the event, say which; it is never a join.
 */
export type OtherEvent = {
  readonly eventId: string;
  readonly eventType: string | null;
  readonly plain: string;
  readonly copies: number;
  readonly store: string;
  readonly atS: number | null;
  readonly related: ReadonlyArray<{ readonly what: string; readonly id: string; readonly steps: readonly number[] }>;
};

export type Tone = "running" | "waiting" | "done" | "stopped" | "queued";

/** A finder run's answer, which leads the page once the run settles: never a green "Done" above a BUG. */
export type VerdictHero = { readonly kind: "bug" | "ok" | "inconclusive"; readonly headline: string; readonly lead: string };

export type RunStory = {
  readonly tone: Tone;
  readonly settled: boolean;
  readonly headline: string;
  readonly lead: string | null;
  readonly progress: { readonly at: number; readonly of: number } | null;
  readonly proof: readonly ProofNode[];
  readonly proofLine: string;
  /** One sentence when a later step's webhook arrived before an earlier step's; null otherwise. */
  readonly outOfOrder: string | null;
  /** The one count of expected events, arrived and verified, that every part of the page uses. */
  readonly counts: { readonly expected: number; readonly arrived: number; readonly verified: number };
  /** Posts the store rejected in this run's window, never added to PayPal's numbers; null when there were none. */
  readonly rejected: string | null;
  readonly verdict: VerdictHero | null;
  readonly figures: {
    readonly steps: string;
    readonly amount: string;
    readonly amountNote: string | null;
    /** Disputed money, said apart from what the calls charged; null when nothing was disputed or amount already says it. */
    readonly disputed: string | null;
    readonly slowest: string;
    readonly signatures: string;
    readonly signaturesOk: boolean | null;
  };
  readonly cards: readonly StepCard[];
  readonly other: readonly OtherEvent[];
  readonly notes: readonly string[];
  readonly view: LiveView;
};

// ------------------------------------------------------------------ plain-English maps

/** What Rehearsal sent, per step kind. The kind itself is shown in Details. */
export const STEP_TITLES: Readonly<Record<string, string>> = {
  card_order: "Payment captured",
  refund: "Refund sent",
  payout_batch: "Payout sent",
  invoice_create: "Invoice created",
  invoice_send: "Invoice sent",
  invoice_record_payment: "Invoice payment recorded",
  invoice_cancel: "Invoice canceled",
  open_dispute: "Dispute opened",
  resend_webhook: "Asked PayPal to resend an event",
};

/** What a step asks for, before PayPal has accepted it. */
export const STEP_ASKS: Readonly<Record<string, string>> = {
  card_order: "Capture a card payment",
  refund: "Send a refund",
  payout_batch: "Send a payout",
  invoice_create: "Create an invoice",
  invoice_send: "Send the invoice",
  invoice_record_payment: "Record the invoice payment",
  invoice_cancel: "Cancel the invoice",
  open_dispute: "Open a dispute",
  resend_webhook: "Ask PayPal to resend an event",
};

/** The first request each kind makes, as the handlers send it. */
export const STEP_REQUESTS: Readonly<Record<string, string>> = {
  card_order: "POST /v2/checkout/orders",
  refund: "POST /v2/payments/captures/{capture_id}/refund",
  payout_batch: "POST /v1/payments/payouts",
  invoice_create: "POST /v2/invoicing/invoices",
  invoice_send: "POST /v2/invoicing/invoices/{invoice_id}/send",
  invoice_record_payment: "POST /v2/invoicing/invoices/{invoice_id}/payments",
  invoice_cancel: "POST /v2/invoicing/invoices/{invoice_id}/cancel",
  open_dispute: "POST /v1/customer/disputes",
  resend_webhook: "POST /v1/notifications/webhooks-events/{event_id}/resend",
};

/**
 * The steps that sit at "Sending" for a minute or two while PayPal works, and
 * why, so they never look frozen. Only what PayPal itself does is said.
 */
export const SLOW_SEND: Readonly<Record<string, string>> = {
  resend_webhook: "PayPal lists a new event before it allows a resend. This usually takes 1 to 2 minutes.",
  open_dispute: "PayPal creates the case, then makes it readable.",
};

/** Measured on 2026-10-23: a CUSTOMER.DISPUTE.CREATED arrived 12h17m after its dispute was filed. */
export const DISPUTE_LAG = "PayPal's sandbox has delivered dispute events up to 12 hours later.";

/** Kinds liveView joins to a delivery (its PAIR_RULES, plus a resend's second copy). */
const JOINED_KINDS = new Set(["card_order", "refund", "open_dispute", "invoice_create", "invoice_record_payment", "resend_webhook"]);

/**
 * The event each joined kind waits for once PayPal accepts it. liveView makes
 * a waiting pair for a card order and a resend; the others are only joined
 * once their event arrives, so until then the card waits on this one.
 */
const EXPECTED_TYPE: Readonly<Record<string, string>> = {
  refund: "PAYMENT.CAPTURE.REFUNDED",
  open_dispute: "CUSTOMER.DISPUTE.CREATED",
  invoice_create: "INVOICING.INVOICE.CREATED",
  invoice_record_payment: "INVOICING.INVOICE.PAID",
};

/**
 * What PayPal sent back, per event type. Anything not listed reads as a
 * plain fallback, with the type itself in Details; nothing is guessed from
 * a type this console does not know.
 */
export const EVENT_PLAIN: Readonly<Record<string, string>> = {
  "PAYMENT.CAPTURE.COMPLETED": "Payment completed",
  "PAYMENT.CAPTURE.PENDING": "PayPal says the payment is pending",
  "PAYMENT.CAPTURE.DENIED": "PayPal says the payment was denied",
  "PAYMENT.CAPTURE.REFUNDED": "Refund completed",
  "PAYMENT.CAPTURE.REVERSED": "PayPal says the payment was reversed",
  "CHECKOUT.ORDER.APPROVED": "Order approved",
  "CHECKOUT.ORDER.COMPLETED": "Order completed",
  "INVOICING.INVOICE.CREATED": "Invoice created",
  "INVOICING.INVOICE.SENT": "Invoice sent",
  "INVOICING.INVOICE.UPDATED": "PayPal says the invoice changed",
  "INVOICING.INVOICE.UNPAID": "PayPal says the invoice is awaiting payment",
  "INVOICING.INVOICE.PAID": "Invoice paid",
  "CUSTOMER.DISPUTE.CREATED": "Dispute opened",
  "CUSTOMER.DISPUTE.UPDATED": "PayPal says the dispute changed",
  "CUSTOMER.DISPUTE.RESOLVED": "PayPal says the dispute was resolved",
  "PAYMENT.PAYOUTSBATCH.SUCCESS": "Payout batch done",
  "PAYMENT.PAYOUTSBATCH.PROCESSING": "PayPal says the payout batch is processing",
  "PAYMENT.PAYOUTSBATCH.DENIED": "PayPal says the payout batch was denied",
  "PAYMENT.PAYOUTS-ITEM.SUCCEEDED": "Payout item paid",
  "PAYMENT.PAYOUTS-ITEM.UNCLAIMED": "PayPal says a payout item is unclaimed",
};

export const eventPlain = (type: string | null): string => (type !== null && EVENT_PLAIN[type] !== undefined ? EVENT_PLAIN[type]! : "PayPal sent an event this console has no plain name for");

/** Short names for the proof strip. */
const EVENT_SHORT: Readonly<Record<string, string>> = {
  "PAYMENT.CAPTURE.COMPLETED": "Payment",
  "PAYMENT.CAPTURE.REFUNDED": "Refund",
  "CHECKOUT.ORDER.APPROVED": "Order",
  "CHECKOUT.ORDER.COMPLETED": "Order",
  "INVOICING.INVOICE.CREATED": "Invoice",
  "INVOICING.INVOICE.PAID": "Invoice paid",
  "CUSTOMER.DISPUTE.CREATED": "Dispute",
};

/** The noun for an id a step holds, for "same invoice as step 3". */
const ID_NOUN: Readonly<Record<string, string>> = {
  invoice_id: "invoice",
  capture_id: "capture",
  order_id: "order",
  refund_id: "refund",
  dispute_id: "dispute",
};

const STORE_PLAIN: Readonly<Record<string, string>> = {
  fulfilled: "the store fulfilled the order",
  duplicate_ignored: "the store recognized it as a repeat and ignored it",
  refund_recorded: "the store recorded the refund",
  dispute_noted: "the store noted the dispute",
  recorded: "the store recorded it",
  refused: "the store refused it",
};

/**
 * A step's or a run's stored detail, as one human sentence. The raw text is
 * kept for Details. Claims are only made where the detail proves them:
 * "Nothing was sent" only when the engine recorded "not sent".
 */
export function humanReason(raw: string | null): string | null {
  if (raw === null || raw.trim() === "") return null;
  let d = raw.trim().replace(/^step \S+ (failed|ended in an unknown state): /, "");
  const notSent = /\bnot sent\b|before any write/.test(d);
  const token = /token request failed with http (\d{3})(?: \(([a-z_]+)\))?/.exec(d);
  if (token !== null) {
    const role = /the (seller|buyer) app's/.exec(d)?.[1] ?? null;
    const app = role === null ? "the app's" : `the ${role} app's`;
    const proven = notSent || /could not read the webhook list/.test(d);
    if (!proven) return `PayPal refused ${app} login partway through the step (http ${token[1]}${token[2] === undefined ? "" : `, ${token[2]}`}). It may already have written to PayPal; nothing here will retry it.`;
    const login =
      token[1] === "401" && token[2] === "invalid_client"
        ? `PayPal refused ${app} login (its client id and secret do not match a sandbox app).`
        : `PayPal's login service answered http ${token[1]} for ${app.replace(/'s$/, "")}.`;
    return `${login} Nothing was sent.`;
  }
  const left = /^not sent: (\d+) s were left in this server's time, and this step can take (\d+) s/.exec(d);
  if (left !== null) return `Not sent: this server had ${left[1]} s left, and this step can take ${left[2]} s. Nothing was sent.`;
  if (/hosted purchase bank has no purchase ready/.test(d)) return "Not sent: no banked purchase is ready to dispute. Nothing was sent.";
  if (/no webhook is registered at/.test(d)) return "The sample store's webhook is not registered on this sandbox account, so the run stopped before sending anything.";
  const refused = /^http (\d{3}): PayPal refused the request/.exec(d);
  if (refused !== null) return `PayPal refused the request (http ${refused[1]}). Nothing was written.`;
  const ambiguous = /^http (\d{3}): (the write may or may not have executed|server error, state unproven)/.exec(d);
  if (ambiguous !== null) return `PayPal's reply (http ${ambiguous[1]}) does not say whether the request went through. It may have; nothing here will retry it.`;
  const threw = /^handler threw: (\w+): /.exec(d);
  if (threw !== null) return `The step stopped on an error (${threw[1]}). It may have written to PayPal; nothing here will retry it.`;
  if (/^started and never confirmed/.test(d)) return "Started, but its outcome was never recorded. It may have written to PayPal; nothing here will retry it.";
  if (/stopped on an internal error/.test(d)) return "The run stopped on an internal error. A step it had started may have written to PayPal; nothing here will retry it.";
  if (/the server running this stopped/.test(d)) return "The server running this stopped. A step it had started may have written to PayPal; nothing here will retry it.";
  d = d.charAt(0).toUpperCase() + d.slice(1);
  return /[.!?]$/.test(d) ? d : `${d}.`;
}

/** An outcome nobody can prove gets the warning, whatever its detail says. */
function withWarning(sent: SentState, sentence: string | null): string | null {
  if (sent !== "unknown" && sent !== "never-confirmed") return sentence;
  if (sentence !== null && /may (already )?have written/.test(sentence)) return sentence;
  return `${sentence === null ? "" : `${sentence} `}It may have written to PayPal; nothing here will retry it.`;
}

/** PayPal's own error code, for Details, when the detail carries one. */
export function paypalCode(raw: string | null): string | null {
  return raw === null ? null : (/\(([a-z_]{3,40})\)/.exec(raw)?.[1] ?? null);
}

/** "12s", "1m 22s". */
export function dur(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

/** "USD 45", "USD 45.50": whole amounts read without the cents. */
export function money(currency: string, amount: string): string {
  return `${currency} ${amount.replace(/\.00?$/, "")}`;
}

const ordinal = (n: number) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? "th" : (["th", "st", "nd", "rd"][n % 10] ?? "th")}`;
export const arrivalWord = (rank: number) => `${ordinal(rank)} to arrive`;

// ------------------------------------------------------------------ the plan

type PlanStep = { id: string; kind: string; amount: string | null; from: string | null; mode: string | null; basisPoints: number | null };
type Plan = { currency: string; steps: PlanStep[] };

const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

/** The plan note the worker records on the first save; else the saved run state; else the steps seen. */
function planOf(read: LiveRead, view: LiveView): Plan {
  for (const e of read.events) {
    const p = e.kind === "note" ? e.data["plan"] : undefined;
    if (typeof p !== "object" || p === null || !Array.isArray((p as Record<string, unknown>)["steps"])) continue;
    const r = p as Record<string, unknown>;
    const steps = (r["steps"] as unknown[]).flatMap((x): PlanStep[] => {
      if (typeof x !== "object" || x === null) return [];
      const s = x as Record<string, unknown>;
      const id = str(s["id"]);
      if (id === null) return [];
      const amount = str(s["amount"]);
      return [{
        id,
        kind: str(s["kind"]) ?? "step",
        amount: amount !== null && /^\d+(\.\d{1,2})?$/.test(amount) ? amount : null,
        from: str(s["from"]),
        mode: str(s["mode"]),
        basisPoints: typeof s["basisPoints"] === "number" ? s["basisPoints"] : null,
      }];
    });
    if (steps.length > 0) return { currency: str(r["currency"]) ?? "USD", steps };
  }
  const state = read.run.state as Record<string, unknown> | null;
  if (state !== null && typeof state === "object" && Array.isArray(state["order"]) && typeof state["steps"] === "object" && state["steps"] !== null) {
    const recs = state["steps"] as Record<string, Record<string, unknown> | undefined>;
    const steps = (state["order"] as unknown[]).flatMap((id): PlanStep[] =>
      typeof id === "string" ? [{ id, kind: str(recs[id]?.["kind"]) ?? "step", amount: null, from: null, mode: null, basisPoints: null }] : [],
    );
    if (steps.length > 0) return { currency: str(state["currency"]) ?? "USD", steps };
  }
  return { currency: "USD", steps: view.calls.map((c) => ({ id: c.step, kind: c.kind, amount: null, from: c.from, mode: null, basisPoints: null })) };
}

function titleOf(step: PlanStep, accepted: boolean): string {
  const part = step.mode === "partial" && step.basisPoints !== null ? ` (${step.basisPoints / 100}%)` : "";
  if (!accepted) return step.kind === "refund" ? `Send a ${step.mode === "partial" ? "partial" : step.mode === "full" ? "full" : ""} refund${part}`.replace("a  refund", "a refund") : (STEP_ASKS[step.kind] ?? "Run a step");
  if (step.kind === "refund") return step.mode === "partial" ? `Partial refund sent${part}` : step.mode === "full" ? "Full refund sent" : "Refund sent";
  return STEP_TITLES[step.kind] ?? "Step sent";
}

const AMOUNT = /^\d+(\.\d{1,2})?$/;

/**
 * The engine leads a dispute's detail with this line when PayPal's read-back
 * names a different capture than the bank's. The token alone raises the flag:
 * however the ids after it print, or wherever a length cap cuts it, it shows.
 */
function pairingLine(detail: string | null): string | null {
  const at = detail === null ? -1 : detail.indexOf("pairing_mismatch");
  if (at < 0) return null;
  const line = detail!.slice(at);
  const end = line.indexOf("; ");
  return end < 0 ? line : line.slice(0, end);
}

const centsOf = (amount: string): bigint => {
  const [w, f = ""] = amount.split(".");
  return BigInt(w!) * 100n + BigInt(f.padEnd(2, "0").slice(0, 2));
};
const fromCents = (c: bigint) => `${c / 100n}.${String(c % 100n).padStart(2, "0")}`;

// ------------------------------------------------------------------ the story

export function runStory(read: LiveRead): RunStory {
  const view = liveView(read);
  const plan = planOf(read, view);
  const nowS = view.elapsedS;
  const dead = view.phase === "abandoned" || view.phase === "failed";
  const haltEvent = read.events.find((e) => e.kind === "run_halted");
  const halted = view.phase === "halted" || haltEvent !== undefined || (dead && view.calls.some((c) => c.status !== "succeeded"));

  const calls = new Map(view.calls.map((c) => [c.step, c]));
  const deliveries = new Map(view.deliveries.map((d) => [d.key, d]));
  const ledger = new Map(view.ledger.map((l) => [l.eventId, l]));

  // Arrival rank, across every joined delivery seen so far.
  const arrivedPairs = view.pairs.filter((p) => p.arrivedT !== null).sort((a, b) => a.arrivedT! - b.arrivedT! || a.deliveryKey.localeCompare(b.deliveryKey));
  const rankOf = new Map(arrivedPairs.map((p, i) => [p.deliveryKey, i + 1]));

  const repliesOf = (callKey: string): Reply[] =>
    view.pairs
      .filter((p) => p.callKey === callKey)
      .map((p): Reply => {
        const d = deliveries.get(p.deliveryKey);
        const eventId = d?.facts.find(([k]) => k === "event")?.[1] ?? null;
        const l = eventId === null ? undefined : ledger.get(eventId);
        const redelivery = p.deliveryKey.startsWith("d:redelivery:");
        const type = d === undefined ? (p.what.includes("capture") ? "PAYMENT.CAPTURE.COMPLETED" : null) : d.title.replace(/ · 2nd delivery$/, "");
        const store = d?.facts.find(([k]) => k === "store")?.[1] ?? null;
        const copies = l?.deliveries ?? (d === undefined ? 0 : 1);
        return {
          key: p.deliveryKey,
          eventId,
          eventType: type ?? "event",
          plain: redelivery ? `PayPal delivered it again; ${/^fulfilled/.test(store ?? "") ? "the store fulfilled the order a second time" : (STORE_PLAIN[store ?? ""] ?? "the store recorded it")}` : eventPlain(type),
          arrived: p.arrivedT !== null,
          latencyS: p.arrivedT === null || p.arrivedT < p.callT ? null : p.arrivedT - p.callT,
          exact: p.exact,
          early: p.arrivedT !== null && p.arrivedT < p.callT,
          rank: rankOf.get(p.deliveryKey) ?? null,
          receivedAt: d?.at ?? null,
          verified: l === undefined ? copies : Math.max(0, l.deliveries - l.refused),
          copies,
          store,
          redelivery,
        };
      })
      .sort((a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9));

  let currentId: string | null = null;
  const cards: StepCard[] = plan.steps.map((step, i) => {
    const call = calls.get(step.id);
    const kind = call?.kind ?? step.kind;
    let replies = call === undefined ? [] : repliesOf(call.key);
    if (call?.status === "succeeded" && replies.length === 0 && EXPECTED_TYPE[kind] !== undefined) {
      const type = EXPECTED_TYPE[kind]!;
      replies = [{ key: `d:expected:${step.id}`, eventId: null, eventType: type, plain: eventPlain(type), arrived: false, latencyS: null, exact: false, early: false, rank: null, receivedAt: null, verified: 0, copies: 0, store: null, redelivery: false }];
    }
    // A step still pending once the run has ended or stopped will never run.
    let sent: SentState = view.settled || halted ? "not-run" : "queued";
    if (call !== undefined) {
      if (call.status === "in-flight") sent = "sending";
      else if (call.status === "never-confirmed") sent = "never-confirmed";
      else if (call.status === "succeeded") sent = "accepted";
      else if (call.status === "failed") sent = /^not sent\b/.test(call.detail) ? "not-sent" : "refused";
      else sent = "unknown";
    }
    let reply: ReplyState = "none";
    let waitingS: number | null = null;
    if (sent === "accepted") {
      if (replies.length === 0) reply = JOINED_KINDS.has(kind) ? "not-yet" : "none-expected";
      else if (replies.every((r) => r.arrived)) reply = "delivered";
      else if (view.settled || dead) reply = "not-seen";
      else {
        reply = "waiting";
        waitingS = Math.max(0, nowS - (call?.t ?? nowS));
      }
      // A resend whose second copy has not been seen yet is still waiting, not "none".
      if (reply === "not-yet") {
        if (view.settled) reply = "none-expected";
        else waitingS = Math.max(0, nowS - (call?.t ?? nowS));
      }
    } else if (sent === "queued" && JOINED_KINDS.has(kind)) {
      reply = "not-yet";
    } else if (sent === "queued" || sent === "sending") {
      reply = JOINED_KINDS.has(kind) ? "not-yet" : "none-expected";
    }
    const amount = step.amount === null ? null : money(plan.currency, step.amount);
    const detail = call?.detail ?? null;
    const slow = sent === "sending" && SLOW_SEND[kind] !== undefined;
    const card: StepCard = {
      id: step.id,
      n: i + 1,
      kind,
      title: titleOf({ ...step, kind }, sent === "accepted"),
      amount,
      sent,
      sentWord: SENT_WORDS[sent],
      reply,
      replies,
      waitingS,
      current: false,
      problem: sent === "refused" || sent === "not-sent" || sent === "unknown" || sent === "never-confirmed" ? withWarning(sent, humanReason(detail) ?? humanReason(read.run.halt_reason)) : null,
      sendingS: slow ? Math.max(0, nowS - (call?.t ?? nowS)) : null,
      sendingNote: slow ? SLOW_SEND[kind]! : null,
      pairing: kind === "open_dispute" ? pairingLine(detail) : null,
      lateNote: kind === "open_dispute" && reply === "not-seen" ? DISPUTE_LAG : null,
      details: {
        kind,
        request: STEP_REQUESTS[kind] ?? null,
        ids: call === undefined ? [] : Object.entries(call.ids),
        startedAt: read.events.find((e) => e.kind === "step_started" && e.step_id === step.id)?.at ?? null,
        acceptedAt: call !== undefined && call.status !== "in-flight" && call.status !== "never-confirmed" ? call.at : null,
        detail,
        paypalCode: paypalCode(detail),
        from: call?.from ?? step.from,
      },
    };
    return card;
  });

  if (!view.settled && !dead) {
    currentId = cards.find((c) => c.sent === "sending")?.id ?? cards.find((c) => c.reply === "waiting" || (c.sent === "accepted" && c.reply === "not-yet"))?.id ?? null;
  }
  const finalCards = cards.map((c) => (c.id === currentId ? { ...c, current: true } : c));

  // Figures.
  const total = finalCards.length;
  const done = finalCards.filter((c) => c.sent === "accepted").length;
  let planned = 0n;
  let accepted = 0n;
  for (const [i, c] of finalCards.entries()) {
    const a = plan.steps[i]!.amount;
    if (a === null) continue;
    planned += centsOf(a);
    if (c.sent === "accepted") accepted += centsOf(a);
  }
  // A dispute moves no money in the call, so it is counted apart from what was charged.
  let disputedCents = 0n;
  for (const c of finalCards) {
    const a = c.kind === "open_dispute" && c.sent === "accepted" ? c.details.ids.find(([k]) => k === "dispute_amount")?.[1] : undefined;
    if (a !== undefined && AMOUNT.test(a)) disputedCents += centsOf(a);
  }
  const disputed = disputedCents === 0n ? null : `${money(plan.currency, fromCents(disputedCents))} disputed`;
  const allReplies = finalCards.flatMap((c) => c.replies);
  const timed = allReplies.filter((r) => r.latencyS !== null);
  const slowestReply = timed.length === 0 ? null : timed.reduce((a, b) => (b.latencyS! > a.latencyS! ? b : a));
  // The store keeps no event id on a copy it refused, so those come from its
  // own count for this run's window. Anyone can post to the store's public
  // webhook, so they are said apart and never added to PayPal's numbers.
  const rejectedN = read.events.reduce((m, e) => (e.kind === "note" && typeof e.data["refused_in_window"] === "number" ? Math.max(m, e.data["refused_in_window"] as number) : m), 0);
  const rejected = rejectedN === 0 ? null : `${rejectedN} ${rejectedN === 1 ? "post" : "posts"} to the store ${rejectedN === 1 ? "was" : "were"} refused: malformed, or a signature that failed or could not be checked. None is counted as PayPal's.`;
  // One count of expected events for the hero, the panel, the strip and the
  // summary: a step still queued counts the one event it will wait for.
  const expected = finalCards.reduce((n, c) => n + (c.replies.length > 0 ? c.replies.length : expectsReply(c) ? 1 : 0), 0);
  const arrived = allReplies.filter((r) => r.arrived).length;
  const verified = allReplies.filter(isVerified).length;
  const waiting = expected - arrived;
  const events = (n: number) => `${n} ${n === 1 ? "event" : "events"}`;
  const paypalOnly = view.ledger.filter((l) => l.deliveries - l.refused > 0).length;

  // The hero, which must match the run's state at every moment.
  const haltedAt = finalCards.find((c) => c.sent === "refused" || c.sent === "not-sent" || c.sent === "unknown" || c.sent === "never-confirmed");
  // A dead server's own reason says more than the step it left unconfirmed.
  const reason =
    (dead ? humanReason(read.run.halt_reason) : null) ??
    (haltedAt === undefined ? null : haltedAt.problem) ??
    humanReason(read.run.halt_reason) ??
    humanReason(str(haltEvent?.data["reason"]));
  const evidence =
    expected === 0
      ? paypalOnly === 0
        ? null
        : `PayPal sent ${events(paypalOnly)}, none tied to a step by this console.`
      : `${arrived} of ${expected} expected ${expected === 1 ? "event" : "events"} arrived${arrived === 0 ? "" : verified === arrived ? ", all verified" : `, ${verified} verified`}.`;
  let tone: Tone;
  let headline: string;
  let lead: string | null;
  const stepsWord = (n: number) => `${n} ${n === 1 ? "step" : "steps"}`;
  const allSteps = (verb: "done" | "sent") => (total === 1 ? `The step ${verb === "done" ? "is done" : "was sent"}.` : `All ${stepsWord(total)} ${verb}.`);
  if (view.phase === "queued") {
    tone = "queued";
    headline = "Queued.";
    lead = "Waiting for the server to start it.";
  } else if (halted) {
    tone = "stopped";
    headline = haltedAt === undefined ? (done === 0 ? "Stopped before step 1." : "Stopped.") : `Stopped at step ${haltedAt.n}.`;
    if (dead) headline = view.phase === "abandoned" ? "The server running this stopped." : "The run stopped on an internal error.";
    const after = !view.settled && waiting > 0 ? ` Still listening for ${events(waiting)} from the steps PayPal accepted.` : "";
    lead = [reason, done > 0 && expected > 0 ? evidence : null].filter((x) => x !== null).join(" ") + after || null;
  } else if (dead) {
    tone = "stopped";
    headline = view.phase === "abandoned" ? "The server running this stopped." : "The run stopped on an internal error.";
    lead = reason;
  } else if (total === 0 && !view.settled) {
    // Started, but the plan note that names the steps has not been read yet.
    tone = "running";
    headline = "Starting.";
    lead = "The server has picked it up. The first step starts in a moment.";
  } else if (view.phase === "complete") {
    tone = "done";
    headline = allSteps("done");
    // When every missing event is a dispute's, its own measured lag says it; otherwise it is added to the general line.
    const unseen = finalCards.filter((c) => c.reply === "not-seen");
    const lag = unseen.length > 0 && unseen.every((c) => c.lateNote !== null) ? DISPUTE_LAG : `PayPal's sandbox has delivered later than that before.${unseen.some((c) => c.lateNote !== null) ? ` ${DISPUTE_LAG}` : ""}`;
    lead =
      waiting === 0
        ? evidence
        : `${evidence ?? ""} ${waiting} expected ${waiting === 1 ? "event was" : "events were"} not seen before the wait ended. That is not proof the store missed ${waiting === 1 ? "it" : "them"}: ${lag}`.trim();
  } else {
    const sending = finalCards.find((c) => c.sent === "sending");
    const next = finalCards.find((c) => c.sent === "queued");
    if (sending !== undefined || next !== undefined) {
      tone = "running";
      const c = (sending ?? next)!;
      headline = `Running step ${c.n} of ${total}: ${c.title}.`;
      lead = sending !== undefined ? "Sending it to PayPal's sandbox now." : done === 0 ? "Starting the first step." : "PayPal accepted the last step; the next one starts now.";
      if (arrived > 0 || done > 0) lead = `${lead} ${arrived} of ${expected} expected ${expected === 1 ? "event" : "events"} arrived so far.`;
    } else {
      tone = "waiting";
      headline = allSteps("sent");
      lead = waiting > 0 ? `Waiting on PayPal for ${events(waiting)}. ${arrived} of ${expected} arrived so far.` : evidence ?? "Finishing up.";
    }
  }

  const progress = tone === "running" && total > 0 ? { at: Math.min(total, finalCards.filter((c) => c.sent !== "queued").length), of: total } : null;

  const stepOf = new Map(finalCards.flatMap((c) => c.replies.map((r) => [r.key, c.n] as const)));
  const shortOf = (r: Reply) => (r.redelivery ? "Resend" : (EVENT_SHORT[r.eventType] ?? "Event"));
  const proof: ProofNode[] = [
    ...arrivedPairs.flatMap((p): ProofNode[] => {
      const r = allReplies.find((x) => x.key === p.deliveryKey);
      if (r === undefined) return [];
      return [{ key: p.deliveryKey, step: stepOf.get(r.key) ?? null, label: shortOf(r), arrived: true, latencyS: r.latencyS, exact: r.exact, early: r.early, verified: isVerified(r) }];
    }),
    ...allReplies.filter((r) => !r.arrived).map((r): ProofNode => ({ key: r.key, step: stepOf.get(r.key) ?? null, label: shortOf(r), arrived: false, latencyS: null, exact: false, early: false, verified: false })),
    // A step still queued shows the event it will wait for, so the strip counts what the hero counts.
    ...finalCards
      .filter((c) => c.replies.length === 0 && expectsReply(c))
      .map((c): ProofNode => ({ key: `p:${c.id}`, step: c.n, label: KIND_SHORT[c.kind] ?? "Event", arrived: false, latencyS: null, exact: false, early: false, verified: false })),
  ];
  const proofLine =
    expected === 0
      ? finalCards.every((c) => c.sent === "not-sent" || c.sent === "not-run" || c.sent === "queued") && (view.settled || halted)
        ? "Nothing was sent, so there was nothing for PayPal to deliver."
        : view.settled
          ? "No event was expected from the steps that ran."
          : "Events appear here as PayPal sends them."
      : `${arrived} of ${expected} arrived.${arrived === 0 ? "" : verified === arrived ? " All verified." : ` ${verified} verified.`}`;

  // PayPal promises no order. When a later step's event beat an earlier
  // step's, that is the clearest true thing the run can show, so it is said.
  let outOfOrder: string | null = null;
  const ranked = finalCards.flatMap((c) => c.replies.filter((r) => r.rank !== null && !r.redelivery).map((r) => ({ n: c.n, rank: r.rank! })));
  for (const b of [...ranked].sort((x, y) => x.rank - y.rank)) {
    const a = ranked.find((x) => x.n < b.n && x.rank > b.rank);
    if (a !== undefined) {
      outOfOrder = `Step ${b.n}'s webhook arrived before step ${a.n}'s. PayPal does not deliver webhooks in order; your app has to handle that.`;
      break;
    }
  }

  const other: OtherEvent[] = view.ledger
    .filter((l) => l.joinedTo.length === 0)
    .map((l) => ({
      eventId: l.eventId,
      eventType: l.eventType,
      plain: eventPlain(l.eventType),
      copies: l.deliveries,
      store: l.duplicatesIgnored > 0 ? "duplicate_ignored" : l.fulfilled > 0 ? "fulfilled" : l.refused > 0 ? "refused" : "recorded",
      atS: l.firstReceivedT ?? l.firstSeenT,
      related: l.resourceIds.flatMap((id) => {
        const holders = finalCards.flatMap((c) => c.details.ids.filter(([k, v]) => v === id && ID_NOUN[k] !== undefined).map(([k]) => ({ n: c.n, k })));
        const nouns = [...new Set(holders.map((h) => ID_NOUN[h.k]!))];
        // Two steps holding the same id under different names says nothing plain.
        return nouns.length === 1 ? [{ what: nouns[0]!, id, steps: holders.map((h) => h.n) }] : [];
      }),
    }));

  const notes: string[] = [];
  if (!view.settled && view.lastContactS !== null && view.lastContactS > 30) notes.push(`No word from the server for ${Math.round(view.lastContactS)} s. After 90 s the run is marked stopped.`);
  if (view.storeUnread) notes.push("The store's state endpoint could not be read at least once, so an event may show late or not at all.");

  return {
    tone,
    settled: view.settled,
    headline,
    lead,
    progress,
    proof,
    proofLine,
    outOfOrder,
    counts: { expected, arrived, verified },
    rejected,
    verdict: verdictHero(view.finding),
    figures: {
      steps: `${done} of ${total}`,
      amount: planned === 0n ? (disputed ?? "none") : money(plan.currency, fromCents(accepted)),
      amountNote:
        planned === 0n || accepted === planned
          ? null
          : `of ${money(plan.currency, fromCents(planned))} planned${finalCards.some((c) => c.sent === "unknown" || c.sent === "never-confirmed") ? "; one step's outcome is unknown" : ""}`,
      disputed: planned === 0n ? null : disputed,
      // Once the run has ended nothing more is waited for, so it says what happened.
      // An event that landed while its step was still checking has no latency, but it did arrive.
      slowest: slowestReply === null ? (arrived > 0 ? "during its step" : waiting > 0 ? (view.settled ? "none arrived" : "waiting") : "none") : `${slowestReply.exact ? "" : "at most "}${dur(slowestReply.latencyS!)}`,
      signatures: expected === 0 ? (view.settled ? "none" : "none yet") : `${verified} of ${expected}`,
      // A check only when every expected event arrived verified; a cross when one arrived unverified.
      signaturesOk: expected === 0 ? null : verified === expected ? true : arrived > verified ? false : null,
    },
    cards: finalCards,
    other,
    notes,
    view,
  };
}

/** Every copy the store recorded passed PayPal's signature check. */
const isVerified = (r: Reply) => r.arrived && r.copies > 0 && r.verified === r.copies;

/** A step the console ties a PayPal event to, whether or not it has arrived yet. */
export const expectsReply = (c: StepCard) => c.replies.length > 0 || c.reply === "not-yet" || c.reply === "waiting";

/** The event a queued step will wait for, by its kind, for the proof strip. */
const KIND_SHORT: Readonly<Record<string, string>> = {
  card_order: "Payment",
  refund: "Refund",
  open_dispute: "Dispute",
  invoice_create: "Invoice",
  invoice_record_payment: "Invoice paid",
  resend_webhook: "Resend",
};

/** The page's headline for one class and verdict, where a plain sentence says it better than the class title. */
const CLASS_HEADLINES: Readonly<Record<string, { readonly bug: string; readonly ok: string }>> = {
  "duplicate-webhook": {
    bug: "one payment event was fulfilled twice.",
    ok: "the payment was fulfilled once, and PayPal's redelivery was recognized as a repeat and ignored.",
  },
};

const sentence = (t: string) => {
  const s = t.trim();
  return s === "" ? s : `${s.charAt(0).toUpperCase()}${s.slice(1)}${/[.!?]$/.test(s) ? "" : "."}`;
};

/** The finder's answer, worded for the hero. INCONCLUSIVE always carries its reason. */
export function verdictHero(f: LiveView["finding"]): VerdictHero | null {
  if (f === null) return null;
  if (f.verdict === "inconclusive") return { kind: "inconclusive", headline: "INCONCLUSIVE: not enough evidence to call it.", lead: sentence(f.actual === "" ? "the run did not record why" : f.actual) };
  const known = CLASS_HEADLINES[f.classId];
  const title = f.title === "" ? "this check" : f.title.charAt(0).toLowerCase() + f.title.slice(1);
  // Unnamed classes get a neutral line: some read PayPal's own record, not the store, so none may credit the store.
  const said = f.verdict === "bug" ? (known?.bug ?? `the check failed: ${title}.`) : (known?.ok ?? `the expected outcome was observed: ${title}.`);
  return { kind: f.verdict, headline: `${f.verdict === "bug" ? "BUG" : "OK"}: ${said}`, lead: sentence(f.actual) };
}

const SENT_WORDS: Record<SentState, string> = {
  queued: "Queued",
  "not-run": "Not run",
  sending: "Sending to PayPal",
  accepted: "PayPal accepted",
  refused: "PayPal refused",
  "not-sent": "Not sent",
  unknown: "Outcome unknown",
  "never-confirmed": "Outcome never recorded",
};
