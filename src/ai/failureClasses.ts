import type { RunState, StepRecord } from "../core/runState";
import type { Step } from "../core/scenario";
import { DUE_DATE_UNREAD, NOT_PAST_DUE, READS_OVERDUE } from "../executor/handlers/invoice";
import { ITEM_STATUS_MISMATCH } from "../executor/handlers/payout";
import { cleanModelText } from "./planner";

/**
 * The failure classes the edge-case finder aims at, each with a PURE check so
 * the verdict is testable without a network.
 *
 * A check returns one of three verdicts, and "inconclusive" is a first-class
 * answer. A class whose scenario did not actually produce the condition has not
 * passed; it was not tested, and saying so is the difference between a finder
 * and a rubber stamp.
 */

export type StoreOrder = {
  readonly captureId: string;
  readonly fulfilmentCount: number;
  readonly refundCount: number;
  readonly disputeCount: number;
  readonly duplicatesIgnored: number;
};

/** The store's record of one event id: how many deliveries did what. */
export type StoreDelivery = {
  readonly eventId: string;
  readonly fulfilled: number;
  readonly duplicatesIgnored: number;
  readonly other: number;
  /** Why deliveries of this event were refused, when any were. */
  readonly refusalReasons?: readonly string[];
};

export type StoreSnapshot = {
  readonly orders: readonly StoreOrder[];
  /** Absent on a store deployment that predates per-event reporting. */
  readonly deliveries?: readonly StoreDelivery[];
  /** Refusals with no event id to file them under, such as a body that was not JSON. */
  readonly unattributedRefusals?: { readonly count: number; readonly reasons: readonly string[] };
  readonly eventCount: number;
  readonly unverifiedCount: number;
  readonly dedupeEnabled?: boolean;
  /**
   * True when the store's read of verified rows hit its row cap, so evidence
   * may be missing from the window. Absent on a store that predates the flag.
   */
  readonly truncated?: boolean;
};

export type Verdict = "bug" | "ok" | "inconclusive";

export type Finding = {
  readonly classId: string;
  readonly title: string;
  readonly verdict: Verdict;
  /** Which PayPal event the finding concerns. */
  readonly event: string;
  readonly expected: string;
  readonly actual: string;
  readonly likelyFix: string;
};

/**
 * The fixed shape of a class's scenario. The planner fills values; it never
 * chooses steps. Left to choose, it padded a two-step test with a payout that
 * could not run, and the halt hid the class entirely.
 */
export type ScenarioTemplate = {
  /** Exactly these steps, in this order. Values here are the defaults. */
  readonly steps: readonly Step[];
  /** Per step id, the only fields taken from the planner. Dotted paths reach into arrays. */
  readonly fillable: Readonly<Record<string, readonly string[]>>;
  /** True when the run must use the store's existing webhook, to resend to it. */
  readonly needsWebhook: boolean;
};

export type FailureClass = {
  readonly id: string;
  readonly title: string;
  /** Appended to the description so the planner aims at this class. */
  readonly ask: string;
  /** Null only for an unsupported class, which never runs. */
  readonly template: ScenarioTemplate | null;
  readonly needsBankedPurchase: boolean;
  /** False when v0.2.0 cannot express the scenario; reported, never silently dropped. */
  readonly supported: boolean;
  readonly unsupportedReason?: string;
  check(store: StoreSnapshot, run: RunState): Finding;
  /**
   * For a class whose evidence arrives after the run, such as a redelivery:
   * true once the store shows enough to decide, or once waiting cannot help.
   * The finder re-reads the store until then, up to a timeout.
   */
  settled?(store: StoreSnapshot, run: RunState): boolean;
};

const stepsOfKind = (run: RunState, kind: string): StepRecord[] =>
  Object.values(run.steps).filter((s) => s.kind === kind);

function finding(
  base: Pick<FailureClass, "id" | "title">,
  verdict: Verdict,
  parts: { event: string; expected: string; actual: string; likelyFix: string },
): Finding {
  return { classId: base.id, title: base.title, verdict, ...parts };
}

type DeliveryEvidence =
  | { readonly kind: "no-resend" }
  | { readonly kind: "no-event-id" }
  | { readonly kind: "unreported" }
  | { readonly kind: "malformed"; readonly eventId: string }
  | {
      readonly kind: "counts";
      readonly eventId: string;
      readonly fulfilled: number;
      readonly duplicatesIgnored: number;
      readonly other: number;
      readonly reasons: readonly string[];
    };

const isCount = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= 0;

/**
 * What the store recorded for the one event id the run resent. The store is the
 * system under test, so its reply is checked here rather than trusted: anything
 * malformed is no evidence at all.
 */
function resentDelivery(store: StoreSnapshot, run: RunState): DeliveryEvidence {
  const resend = stepsOfKind(run, "resend_webhook").find((s) => s.status === "succeeded");
  if (resend === undefined) return { kind: "no-resend" };
  const eventId = resend.ids["resent_event_id"];
  if (eventId === undefined || eventId.trim() === "") return { kind: "no-event-id" };

  if (!Array.isArray(store.deliveries)) return { kind: "unreported" };
  const entries = store.deliveries.filter(
    (d) => typeof d === "object" && d !== null && d.eventId === eventId,
  );
  if (entries.length === 0) {
    return { kind: "counts", eventId, fulfilled: 0, duplicatesIgnored: 0, other: 0, reasons: [] };
  }
  const d = entries[0]!;
  // The store groups by event id, so two entries for one id is a broken reply.
  if (entries.length > 1 || !isCount(d.fulfilled) || !isCount(d.duplicatesIgnored) || !isCount(d.other)) {
    return { kind: "malformed", eventId };
  }
  return {
    kind: "counts",
    eventId,
    fulfilled: d.fulfilled,
    duplicatesIgnored: d.duplicatesIgnored,
    other: d.other,
    reasons: storeStrings(d.refusalReasons),
  };
}

/** Store-written text, which ends up in a terminal: strings only, few, short, printable. */
function storeStrings(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((r): r is string => typeof r === "string")
    .slice(0, 5)
    .map((r) => cleanModelText(r, 200))
    .filter((r) => r !== "");
}

/**
 * What the store refused, quoted into an inconclusive finding. A refused resend
 * is the likeliest reason a second delivery is missing, so it must be visible.
 */
function refusalNote(store: StoreSnapshot, reasons: readonly string[]): string {
  const parts: string[] = [];
  if (reasons.length > 0) parts.push(`refused for this event: ${reasons.join("; ")}`);
  const loose = store.unattributedRefusals;
  if (typeof loose === "object" && loose !== null && isCount(loose.count) && loose.count > 0) {
    const why = storeStrings(loose.reasons);
    parts.push(
      `${loose.count} refused request(s) with no event id in the same window${why.length > 0 ? `: ${why.join("; ")}` : ""}`,
    );
  }
  return parts.length === 0 ? "" : ` (${parts.join(". ")})`;
}

const decisive = (e: DeliveryEvidence) =>
  e.kind === "counts" && (e.fulfilled >= 2 || (e.fulfilled === 1 && e.duplicatesIgnored >= 1));

type RefundEvidence =
  | { readonly kind: "too-few-steps"; readonly planned: number }
  | { readonly kind: "unknown-step"; readonly stepId: string }
  | { readonly kind: "none-accepted" }
  | { readonly kind: "no-refund-id"; readonly stepId: string }
  | { readonly kind: "malformed"; readonly refundId: string }
  | {
      readonly kind: "counts";
      readonly perRefund: readonly { readonly refundId: string; readonly recorded: number }[];
      readonly refusedByPaypal: number;
    };

/**
 * What the store recorded for each refund PayPal accepted in this run.
 *
 * A PAYMENT.CAPTURE.REFUNDED event carries the refund as its resource, so the
 * store files it under the refund id, not the capture id. Matching on refund
 * ids also keeps refunds from other runs in the same window out of the count.
 */
function refundEvidence(store: StoreSnapshot, run: RunState): RefundEvidence {
  const refunds = stepsOfKind(run, "refund");
  if (refunds.length < 2) return { kind: "too-few-steps", planned: refunds.length };
  // PayPal may or may not have accepted an unknown refund, so the count to
  // expect is itself unknown.
  const unknown = refunds.find((r) => r.status !== "succeeded" && r.status !== "failed");
  if (unknown !== undefined) return { kind: "unknown-step", stepId: unknown.id };
  const accepted = refunds.filter((r) => r.status === "succeeded");
  if (accepted.length === 0) return { kind: "none-accepted" };

  const perRefund: { refundId: string; recorded: number }[] = [];
  for (const r of accepted) {
    const refundId = r.ids["refund_id"];
    if (refundId === undefined || refundId.trim() === "") return { kind: "no-refund-id", stepId: r.id };
    const entries = store.orders.filter(
      (o) => typeof o === "object" && o !== null && o.captureId === refundId,
    );
    if (entries.length === 0) {
      perRefund.push({ refundId, recorded: 0 });
      continue;
    }
    // The store groups by resource id, so two entries for one id is a broken reply.
    if (entries.length > 1 || !isCount(entries[0]!.refundCount)) return { kind: "malformed", refundId };
    perRefund.push({ refundId, recorded: entries[0]!.refundCount });
  }
  return { kind: "counts", perRefund, refusedByPaypal: refunds.length - accepted.length };
}

const refundDecisive = (e: RefundEvidence) =>
  e.kind === "counts" &&
  (e.perRefund.some((p) => p.recorded >= 2) || e.perRefund.every((p) => p.recorded === 1));

/** Our instruction to the planner, derived from the template so the two cannot drift. */
export function askFor(template: ScenarioTemplate): string {
  const fields = template.steps
    .map((s) => `${s.id}: ${(template.fillable[s.id] ?? []).join(", ") || "nothing"}`)
    .join("; ");
  return [
    "Use exactly these steps, with these ids, kinds, needs, from and eventType, and no other steps:",
    JSON.stringify(template.steps),
    `You may change only these values (${fields}).`,
    "Do not include a webhook block; the runner supplies it.",
  ].join(" ");
}

function withTemplate(
  cls: Omit<FailureClass, "ask" | "template">,
  template: ScenarioTemplate,
): FailureClass {
  return { ...cls, template, ask: askFor(template) };
}

const DUPLICATE_WEBHOOK = {
  id: "duplicate-webhook",
  title: "A redelivered capture event fulfills the order twice",
};

const REFUND_AFTER_PARTIAL = {
  id: "refund-after-partial",
  title: "A second refund after a partial one",
};

const UNCLAIMED_PAYOUT = { id: "unclaimed-payout", title: "A payout nobody claims" };

const OVERDUE_INVOICE = { id: "overdue-invoice", title: "An invoice already past its due date" };

const DISPUTE_ON_REFUNDED = {
  id: "dispute-on-refunded-order",
  title: "A dispute against an order that was already refunded",
};

export const FAILURE_CLASSES: readonly FailureClass[] = [
  withTemplate({
    ...DUPLICATE_WEBHOOK,
    needsBankedPurchase: false,
    supported: true,
    /**
     * The verdict rests on the store's rows for the resent event id, never on
     * having waited. A redelivery that has not arrived yet looks exactly like
     * a store that coped, so one row is inconclusive, never ok.
     */
    check(store: StoreSnapshot, run: RunState) {
      const event = "PAYMENT.CAPTURE.COMPLETED";
      const e = resentDelivery(store, run);
      const none = (actual: string, likelyFix: string) =>
        finding(DUPLICATE_WEBHOOK, "inconclusive", {
          event,
          expected: "a second delivery of the resent event id to reach the store",
          actual,
          likelyFix,
        });

      switch (e.kind) {
        case "no-resend":
          return none(
            "no resend step completed, so no duplicate was ever delivered",
            "re-run with a scenario whose resend_webhook step succeeds",
          );
        case "no-event-id":
          return none(
            "the resend step recorded no event id, so there is nothing to match in the store",
            "check the resend_webhook handler records resent_event_id",
          );
        case "unreported":
          return none(
            "the store does not report deliveries by event id, so a second delivery cannot be proved",
            "deploy the current store, whose state endpoint reports deliveries per event id",
          );
        case "malformed":
          return none(
            `the store's record for ${e.eventId} is malformed, so it proves nothing`,
            "check the store's state endpoint",
          );
        case "counts":
          break;
      }

      if (e.fulfilled >= 2) {
        return finding(DUPLICATE_WEBHOOK, "bug", {
          event,
          expected: "one fulfillment for an event id, however many times it is delivered",
          actual: `event ${e.eventId} was delivered ${e.fulfilled + e.duplicatesIgnored + e.other} times and fulfilled ${e.fulfilled} times`,
          likelyFix:
            "treat the webhook event id as an idempotency key: record it and ignore an event already seen before fulfilling",
        });
      }
      if (e.fulfilled === 1 && e.duplicatesIgnored >= 1) {
        return finding(DUPLICATE_WEBHOOK, "ok", {
          event,
          expected: "one fulfillment for an event id, however many times it is delivered",
          actual: `event ${e.eventId} was fulfilled once and its ${e.duplicatesIgnored} redelivery(s) recognized and ignored`,
          likelyFix: "none needed",
        });
      }

      const rows = e.fulfilled + e.duplicatesIgnored + e.other;
      const note = refusalNote(store, e.reasons);
      if (rows <= 1) {
        return none(
          (rows === 0
            ? `the store recorded no delivery of ${e.eventId}`
            : `only one delivery of ${e.eventId} reached the store before the wait ended; a duplicate that never arrived proves nothing`) + note,
          note === ""
            ? "re-run; if it repeats, check PayPal's delivery status for the webhook"
            : "read the refusal reasons: the store refused a request in this window",
        );
      }
      return none(
        `event ${e.eventId} reached the store ${rows} times but was fulfilled ${e.fulfilled} times, with ${e.other} delivery(s) neither fulfilled nor recognized as duplicates${note}`,
        "check the store is verifying signatures: it refuses anything it cannot verify",
      );
    },
    settled(store: StoreSnapshot, run: RunState) {
      const e = resentDelivery(store, run);
      // Waiting only helps while there are counts that could still grow.
      return e.kind !== "counts" || decisive(e);
    },
  }, {
    steps: [
      { id: "order", kind: "card_order", needs: [], amount: "25.00" },
      {
        id: "resend-capture",
        kind: "resend_webhook",
        needs: ["order"],
        from: "order",
        eventType: "PAYMENT.CAPTURE.COMPLETED",
      },
    ],
    fillable: { order: ["amount"] },
    needsWebhook: true,
  }),

  withTemplate({
    ...REFUND_AFTER_PARTIAL,
    needsBankedPurchase: false,
    supported: true,
    /**
     * Like duplicate-webhook, the verdict rests on the store's rows for this
     * run's refund ids. A refund event that has not arrived yet looks exactly
     * like one the store dropped, so a missing count is inconclusive, never ok.
     */
    check(store: StoreSnapshot, run: RunState) {
      const event = "PAYMENT.CAPTURE.REFUNDED";
      const e = refundEvidence(store, run);
      const none = (actual: string, likelyFix: string) =>
        finding(REFUND_AFTER_PARTIAL, "inconclusive", {
          event,
          expected: "one refund event recorded per refund PayPal accepted",
          actual,
          likelyFix,
        });

      switch (e.kind) {
        case "too-few-steps":
          return none(
            `the plan contained ${e.planned} refund step(s)`,
            "re-plan with a partial refund followed by a second refund",
          );
        case "unknown-step":
          return none(
            `refund step ${e.stepId} ended unknown, so PayPal may or may not have accepted it and the count to expect is unknown`,
            "check the refund in PayPal, then re-run",
          );
        case "none-accepted":
          return none(
            "PayPal accepted no refund, so there was nothing for the store to record",
            "re-run with an order that captured, so the partial refund can succeed",
          );
        case "no-refund-id":
          return none(
            `refund step ${e.stepId} recorded no refund id, so there is nothing to match in the store`,
            "check the refund handler records refund_id",
          );
        case "malformed":
          return none(
            `the store's record for refund ${e.refundId} is malformed, so it proves nothing`,
            "check the store's state endpoint",
          );
        case "counts":
          break;
      }

      const twice = e.perRefund.filter((p) => p.recorded >= 2);
      if (twice.length > 0) {
        return finding(REFUND_AFTER_PARTIAL, "bug", {
          event,
          expected: "one refund event recorded per refund PayPal accepted",
          actual: twice.map((p) => `refund ${p.refundId} was recorded ${p.recorded} times`).join("; "),
          likelyFix:
            "dedupe refund events by event id too: the same redelivery hazard applies to every event type, not only captures",
        });
      }

      const accepted = e.perRefund.length;
      // A refused second refund means the store never faced a refund after a
      // partial one, so a clean count proves nothing about the class.
      if (e.refusedByPaypal > 0) {
        return none(
          `PayPal refused ${e.refusedByPaypal} of the ${accepted + e.refusedByPaypal} refund(s) itself, so a second refund after a partial one never happened`,
          "re-run with a partial refund small enough that PayPal accepts the second refund too",
        );
      }
      if (e.perRefund.every((p) => p.recorded === 1)) {
        return finding(REFUND_AFTER_PARTIAL, "ok", {
          event,
          expected: "one refund event recorded per refund PayPal accepted",
          actual: `${accepted} refund(s) accepted and each recorded once`,
          likelyFix: "none needed",
        });
      }

      const missing = e.perRefund.filter((p) => p.recorded === 0).map((p) => p.refundId);
      return none(
        `${accepted - missing.length} of ${accepted} accepted refund(s) had reached the store when the wait ended (missing: ${missing.join(", ")}); a refund event that never arrived proves nothing${refusalNote(store, [])}`,
        "re-run; if it repeats, check the store returns a 2xx for refund events and PayPal's delivery status",
      );
    },
    settled(store: StoreSnapshot, run: RunState) {
      const e = refundEvidence(store, run);
      // Waiting only helps while a missing refund could still arrive.
      return e.kind !== "counts" || refundDecisive(e);
    },
  }, {
    steps: [
      { id: "order", kind: "card_order", needs: [], amount: "40.00" },
      {
        id: "refund-partial",
        kind: "refund",
        needs: ["order"],
        from: "order",
        mode: "partial",
        basisPoints: 5000,
      },
      { id: "refund-second", kind: "refund", needs: ["refund-partial"], from: "order", mode: "full" },
    ],
    fillable: { order: ["amount"], "refund-partial": ["basisPoints"] },
    needsWebhook: false,
  }),

  withTemplate({
    ...UNCLAIMED_PAYOUT,
    needsBankedPurchase: false,
    supported: true,
    /**
     * Decided from what PayPal reported back about the item, never from the
     * step merely not succeeding: a refused batch or a lost reply says nothing
     * about how an unclaimed item settles.
     */
    check(_store: StoreSnapshot, run: RunState) {
      const event = "PAYMENT.PAYOUTS-ITEM.UNCLAIMED";
      const none = (actual: string, likelyFix: string) =>
        finding(UNCLAIMED_PAYOUT, "inconclusive", {
          event,
          expected: "a payout item PayPal settles as UNCLAIMED",
          actual,
          likelyFix,
        });
      const payouts = stepsOfKind(run, "payout_batch");
      if (payouts.length === 0) {
        return none(
          "the plan contained no payout step",
          "re-plan with a payout_batch whose item sets unclaimed to true",
        );
      }
      const settledWrong = payouts.filter(
        (p) => p.status === "failed" && p.detail.startsWith(`${ITEM_STATUS_MISMATCH}:`),
      );
      if (settledWrong.length > 0) {
        return finding(UNCLAIMED_PAYOUT, "bug", {
          event,
          expected: "the item to settle as UNCLAIMED",
          actual: settledWrong.map((p) => `${p.id}: ${p.detail}`).join("; "),
          likelyFix:
            "an item that settles as SUCCESS instead of UNCLAIMED means the address has an account; use a reserved address such as example.com",
        });
      }
      const notSettled = payouts.filter((p) => p.status !== "succeeded");
      if (notSettled.length > 0) {
        return none(
          notSettled
            .map((p) =>
              p.status === "pending"
                ? `${p.id} never ran`
                : `${p.id} ended ${p.status} before PayPal reported how the item settled: ${p.detail}`,
            )
            .join("; "),
          "read the step detail: PayPal refused the batch or its reply was lost, so the item was never observed",
        );
      }
      return finding(UNCLAIMED_PAYOUT, "ok", {
        event,
        expected: "the item to reach UNCLAIMED",
        actual: payouts.map((p) => p.detail).join("; "),
        likelyFix: "none needed",
      });
    },
  }, {
    steps: [
      { id: "payout", kind: "payout_batch", needs: [], items: [{ amount: "5.00", unclaimed: true }] },
    ],
    fillable: { payout: ["items.0.amount", "items.0.note"] },
    needsWebhook: false,
  }),

  withTemplate({
    ...OVERDUE_INVOICE,
    needsBankedPurchase: false,
    supported: true,
    /**
     * Decided only from a send PayPal accepted and a due date it read back. A
     * create that failed leaves the send pending, which is no answer at all.
     */
    check(_store: StoreSnapshot, run: RunState) {
      const event = "INVOICING.INVOICE.SENT";
      const none = (actual: string, likelyFix: string) =>
        finding(OVERDUE_INVOICE, "inconclusive", {
          event,
          expected: "an invoice sent with a due date in the past",
          actual,
          likelyFix,
        });
      const sends = stepsOfKind(run, "invoice_send");
      if (sends.length === 0) {
        return none(
          "the plan sent no invoice",
          "re-plan with invoice_create using a negative dueInDays, then invoice_send",
        );
      }
      const unsent = sends.filter((s) => s.status !== "succeeded");
      if (unsent.length > 0) {
        const blocked = Object.values(run.steps).filter(
          (s) => s.kind === "invoice_create" && s.status !== "succeeded" && s.status !== "pending",
        );
        return none(
          [
            ...unsent.map((s) =>
              s.status === "pending" ? `${s.id} never ran` : `${s.id} ended ${s.status}: ${s.detail}`,
            ),
            ...blocked.map((s) => `${s.id} ended ${s.status}: ${s.detail}`),
          ].join("; "),
          "read the step detail: the invoice was never sent, so whether it reads overdue was never observed",
        );
      }
      const notPast = sends.filter((s) => s.detail.includes(NOT_PAST_DUE));
      if (notPast.length > 0) {
        return finding(OVERDUE_INVOICE, "bug", {
          event,
          expected: "the invoice to read as past its due date once sent",
          actual: notPast.map((s) => `${s.id}: ${s.detail}`).join("; "),
          likelyFix:
            "PayPal computes overdue from the due date, so the invoice must be dated on or after its due date; check dueInDays was negative",
        });
      }
      const unread = sends.filter((s) => !s.detail.includes(READS_OVERDUE));
      if (unread.length > 0) {
        return none(
          unread
            .map((s) => `${s.id}: ${s.detail.includes(DUE_DATE_UNREAD) ? s.detail : `no due date reading in "${s.detail}"`}`)
            .join("; "),
          "re-run; PayPal's reply after the send did not show the due date",
        );
      }
      return finding(OVERDUE_INVOICE, "ok", {
        event,
        expected: "the invoice to read as overdue",
        actual: sends.map((s) => s.detail).join("; "),
        likelyFix: "none needed",
      });
    },
  }, {
    steps: [
      // dueInDays is fixed: a planner-chosen positive value would make the
      // class read as a bug when it was simply never overdue.
      { id: "invoice", kind: "invoice_create", needs: [], amount: "60.00", dueInDays: -7 },
      { id: "send", kind: "invoice_send", needs: ["invoice"], from: "invoice" },
    ],
    fillable: { invoice: ["amount", "itemName"] },
    needsWebhook: false,
  }),

  {
    ...DISPUTE_ON_REFUNDED,
    ask: "",
    template: null,
    needsBankedPurchase: true,
    supported: false,
    unsupportedReason:
      "A dispute can only be opened against a pre-approved purchase drawn from the bank, and a refund step can only target a card_order created in the same run. So there is no way to refund the order that is about to be disputed. Reaching this class needs either a step that refunds a banked purchase, or a dispute that targets a card_order, neither of which v0.2.0 has.",
    check() {
      return finding(DISPUTE_ON_REFUNDED, "inconclusive", {
        event: "CUSTOMER.DISPUTE.CREATED",
        expected: "a dispute raised against an order that was already refunded",
        actual: "not reachable with the step kinds v0.2.0 has, so this class was not tested",
        likelyFix:
          "add a step that refunds a banked purchase, or let open_dispute target a card_order from the same run",
      });
    },
  },
];

/**
 * A class's verdict on a store snapshot. A window the store had to cut may be
 * missing the very rows the class counts, so no verdict is given on one.
 */
export function judge(cls: FailureClass, store: StoreSnapshot, run: RunState): Finding {
  const finding = cls.check(store, run);
  if (store.truncated !== true) return finding;
  return {
    ...finding,
    verdict: "inconclusive",
    actual: `the store's window held more verified rows than it returns, so rows this class counts may be missing (would have read: ${finding.verdict})`,
    likelyFix: "re-run when the store is quieter, or read a shorter window",
  };
}

export function classById(id: string): FailureClass | undefined {
  return FAILURE_CLASSES.find((c) => c.id === id);
}
