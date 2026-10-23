import type { RunState, StepRecord } from "../core/runState";
import type { Step } from "../core/scenario";

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

export type StoreSnapshot = {
  readonly orders: readonly StoreOrder[];
  readonly eventCount: number;
  readonly unverifiedCount: number;
  readonly dedupeEnabled?: boolean;
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
};

const stepsOfKind = (run: RunState, kind: string): StepRecord[] =>
  Object.values(run.steps).filter((s) => s.kind === kind);

const sum = (ns: readonly number[]) => ns.reduce((a, b) => a + b, 0);

function finding(
  base: Pick<FailureClass, "id" | "title">,
  verdict: Verdict,
  parts: { event: string; expected: string; actual: string; likelyFix: string },
): Finding {
  return { classId: base.id, title: base.title, verdict, ...parts };
}

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
  title: "A redelivered capture event fulfils the order twice",
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
    check(store: StoreSnapshot, run: RunState) {
      const resends = stepsOfKind(run, "resend_webhook");
      if (resends.length === 0 || !resends.some((s) => s.status === "succeeded")) {
        return finding(DUPLICATE_WEBHOOK, "inconclusive", {
          event: "PAYMENT.CAPTURE.COMPLETED",
          expected: "a resend to deliver the capture event a second time",
          actual: "no resend step completed, so no duplicate was ever delivered",
          likelyFix: "re-run with a scenario whose resend_webhook step succeeds",
        });
      }

      const doubled = store.orders.filter((o) => o.fulfilmentCount > 1);
      if (doubled.length > 0) {
        return finding(DUPLICATE_WEBHOOK, "bug", {
          event: "PAYMENT.CAPTURE.COMPLETED",
          expected: "exactly one fulfilment per capture, however many times the event arrives",
          actual: doubled
            .map((o) => `${o.captureId} was fulfilled ${o.fulfilmentCount} times`)
            .join("; "),
          likelyFix:
            "treat the webhook event id as an idempotency key: record it and ignore an event already seen before fulfilling",
        });
      }

      if (sum(store.orders.map((o) => o.fulfilmentCount)) === 0) {
        return finding(DUPLICATE_WEBHOOK, "inconclusive", {
          event: "PAYMENT.CAPTURE.COMPLETED",
          expected: "the store to fulfil the order once",
          actual: `the store fulfilled nothing across ${store.eventCount} events, so there was nothing to double-count`,
          likelyFix:
            "check the store is verifying signatures: it ignores anything it cannot verify, which also means it fulfils nothing",
        });
      }

      return finding(DUPLICATE_WEBHOOK, "ok", {
        event: "PAYMENT.CAPTURE.COMPLETED",
        expected: "exactly one fulfilment per capture",
        actual: `each capture fulfilled once, with ${sum(store.orders.map((o) => o.duplicatesIgnored))} duplicate(s) recognised and ignored`,
        likelyFix: "none needed",
      });
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
    check(store: StoreSnapshot, run: RunState) {
      const refunds = stepsOfKind(run, "refund");
      if (refunds.length < 2) {
        return finding(REFUND_AFTER_PARTIAL, "inconclusive", {
          event: "PAYMENT.CAPTURE.REFUNDED",
          expected: "two refunds against one capture",
          actual: `the plan contained ${refunds.length} refund step(s)`,
          likelyFix: "re-plan with a partial refund followed by a second refund",
        });
      }

      const succeeded = refunds.filter((r) => r.status === "succeeded").length;
      const recorded = sum(store.orders.map((o) => o.refundCount));

      if (recorded > succeeded) {
        return finding(REFUND_AFTER_PARTIAL, "bug", {
          event: "PAYMENT.CAPTURE.REFUNDED",
          expected: `${succeeded} refund event(s) recorded, one per refund that actually succeeded`,
          actual: `the store recorded ${recorded}`,
          likelyFix:
            "dedupe refund events by event id too: the same redelivery hazard applies to every event type, not only captures",
        });
      }
      if (recorded < succeeded) {
        return finding(REFUND_AFTER_PARTIAL, "bug", {
          event: "PAYMENT.CAPTURE.REFUNDED",
          expected: `${succeeded} refund event(s) recorded`,
          actual: `the store recorded ${recorded}, so at least one refund never reached it`,
          likelyFix:
            "check the store returns a 2xx for refund events; PayPal stops retrying only once it does",
        });
      }

      return finding(REFUND_AFTER_PARTIAL, "ok", {
        event: "PAYMENT.CAPTURE.REFUNDED",
        expected: "the refund ledger to match what PayPal actually accepted",
        actual: `${succeeded} refund(s) accepted and ${recorded} recorded; PayPal refused any over-refund itself`,
        likelyFix: "none needed",
      });
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
    check(_store: StoreSnapshot, run: RunState) {
      const payouts = stepsOfKind(run, "payout_batch");
      if (payouts.length === 0) {
        return finding(UNCLAIMED_PAYOUT, "inconclusive", {
          event: "PAYMENT.PAYOUTS-ITEM.UNCLAIMED",
          expected: "a payout batch with an unclaimed recipient",
          actual: "the plan contained no payout step",
          likelyFix: "re-plan with a payout_batch whose item sets unclaimed to true",
        });
      }
      const failed = payouts.filter((p) => p.status === "failed" || p.status === "unknown");
      if (failed.length > 0) {
        return finding(UNCLAIMED_PAYOUT, "bug", {
          event: "PAYMENT.PAYOUTS-ITEM.UNCLAIMED",
          expected: "the item to settle as UNCLAIMED",
          actual: failed.map((p) => `${p.id}: ${p.detail}`).join("; "),
          likelyFix:
            "an item that settles as SUCCESS instead of UNCLAIMED means the address has an account; use a reserved address such as example.com",
        });
      }
      return finding(UNCLAIMED_PAYOUT, "ok", {
        event: "PAYMENT.PAYOUTS-ITEM.UNCLAIMED",
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
    check(_store: StoreSnapshot, run: RunState) {
      const sends = stepsOfKind(run, "invoice_send");
      if (sends.length === 0) {
        return finding(OVERDUE_INVOICE, "inconclusive", {
          event: "INVOICING.INVOICE.SENT",
          expected: "an invoice sent with a due date in the past",
          actual: "the plan sent no invoice",
          likelyFix: "re-plan with invoice_create using a negative dueInDays, then invoice_send",
        });
      }
      const overdue = sends.filter((s) => /overdue/i.test(s.detail));
      if (overdue.length === 0) {
        return finding(OVERDUE_INVOICE, "bug", {
          event: "INVOICING.INVOICE.SENT",
          expected: "the invoice to read as past its due date once sent",
          actual: sends.map((s) => `${s.id}: ${s.detail}`).join("; "),
          likelyFix:
            "PayPal computes overdue from the due date, so the invoice must be dated on or after its due date; check dueInDays was negative",
        });
      }
      return finding(OVERDUE_INVOICE, "ok", {
        event: "INVOICING.INVOICE.SENT",
        expected: "the invoice to read as overdue",
        actual: overdue.map((s) => s.detail).join("; "),
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

export function classById(id: string): FailureClass | undefined {
  return FAILURE_CLASSES.find((c) => c.id === id);
}
