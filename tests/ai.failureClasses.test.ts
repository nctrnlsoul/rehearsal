import { describe, expect, it } from "vitest";
import { type RunState, initRunState, recordOutcome } from "../src/core/runState";
import { FAILURE_CLASSES, type StoreSnapshot, classById } from "../src/ai/failureClasses";

const T = "2026-10-23T12:00:00.000Z";

type StepSpec = {
  id: string;
  kind: string;
  status?: "succeeded" | "failed" | "unknown" | "pending";
  detail?: string;
  ids?: Record<string, string>;
};

function runWith(steps: StepSpec[]): RunState {
  let state = initRunState({
    runId: "r-1",
    scenarioName: "t",
    currency: "USD",
    steps: steps.map((s) => ({ id: s.id, kind: s.kind })),
    order: steps.map((s) => s.id),
    nowIso: T,
  });
  for (const s of steps) {
    if (s.status === undefined || s.status === "pending") continue;
    const kind = s.status === "succeeded" ? "success" : s.status === "failed" ? "failed" : "unknown";
    state = recordOutcome(state, s.id, { kind, detail: s.detail ?? "", ids: s.ids ?? {} }, T);
  }
  return state;
}

const store = (over: Partial<StoreSnapshot> = {}): StoreSnapshot => ({
  orders: [],
  eventCount: 0,
  unverifiedCount: 0,
  ...over,
});

const order = (over: Partial<StoreSnapshot["orders"][number]> = {}) => ({
  captureId: "CAP-1",
  fulfilmentCount: 1,
  refundCount: 0,
  disputeCount: 0,
  duplicatesIgnored: 0,
  ...over,
});

const check = (id: string, s: StoreSnapshot, r: RunState) => classById(id)!.check(s, r);

describe("the class list itself", () => {
  it("covers all five classes the milestone names", () => {
    expect(FAILURE_CLASSES).toHaveLength(5);
    expect(FAILURE_CLASSES.map((c) => c.id)).toEqual([
      "duplicate-webhook",
      "refund-after-partial",
      "unclaimed-payout",
      "overdue-invoice",
      "dispute-on-refunded-order",
    ]);
  });

  // A class that cannot be reached must say so, not quietly vanish from a
  // report that then looks complete.
  it("marks the unreachable class unsupported with a stated reason", () => {
    const unsupported = FAILURE_CLASSES.filter((c) => !c.supported);
    expect(unsupported.map((c) => c.id)).toEqual(["dispute-on-refunded-order"]);
    expect(unsupported[0]!.unsupportedReason).toMatch(/banked purchase|card_order/i);
    expect(unsupported[0]!.check(store(), runWith([])).verdict).toBe("inconclusive");
  });
});

describe("duplicate-webhook", () => {
  const EV = "WH-RESENT-1";
  const resent: StepSpec[] = [
    { id: "o1", kind: "card_order", status: "succeeded" },
    { id: "dup", kind: "resend_webhook", status: "succeeded", ids: { resent_event_id: EV } },
  ];
  const delivered = (fulfilled: number, duplicatesIgnored = 0, other = 0) =>
    store({ deliveries: [{ eventId: EV, fulfilled, duplicatesIgnored, other }] });
  const cls = () => classById("duplicate-webhook")!;

  // The planted bug: the same event id delivered twice and acted on twice.
  it("is a bug when the resent event id was fulfilled twice", () => {
    const f = check("duplicate-webhook", delivered(2), runWith(resent));
    expect(f.verdict).toBe("bug");
    expect(f.event).toBe("PAYMENT.CAPTURE.COMPLETED");
    expect(f.actual).toBe(`event ${EV} was delivered 2 times and fulfilled 2 times`);
    expect(f.likelyFix).toMatch(/idempotency key/i);
  });

  it("is ok when the second delivery was recognised and ignored", () => {
    const f = check("duplicate-webhook", delivered(1, 1), runWith(resent));
    expect(f.verdict).toBe("ok");
    expect(f.actual).toContain("recognised and ignored");
  });

  // The false pass this replaces: one row looks exactly like a store that coped.
  it("is inconclusive, never ok, when only one delivery has arrived", () => {
    const f = check("duplicate-webhook", delivered(1), runWith(resent));
    expect(f.verdict).toBe("inconclusive");
    expect(f.actual).toMatch(/only one delivery .* proves nothing/);
  });

  it("is inconclusive when the store recorded no delivery of that event", () => {
    const f = check("duplicate-webhook", delivered(0), runWith(resent));
    expect(f.verdict).toBe("inconclusive");
    expect(f.actual).toContain("no delivery");
  });

  it("judges only the resent event id, not other events for the same capture", () => {
    const other = store({
      orders: [order({ fulfilmentCount: 2 })],
      deliveries: [
        { eventId: "WH-OTHER", fulfilled: 2, duplicatesIgnored: 0, other: 0 },
        { eventId: EV, fulfilled: 1, duplicatesIgnored: 0, other: 0 },
      ],
    });
    expect(check("duplicate-webhook", other, runWith(resent)).verdict).toBe("inconclusive");
  });

  // An older store deployment reports per capture only. That is not evidence
  // of one event arriving twice, so it never yields a bug or a pass.
  it("is inconclusive when the store does not report deliveries by event id", () => {
    const old = store({ orders: [order({ fulfilmentCount: 2 })], eventCount: 2 });
    const f = check("duplicate-webhook", old, runWith(resent));
    expect(f.verdict).toBe("inconclusive");
    expect(f.likelyFix).toMatch(/deploy the current store/);
  });

  it("is inconclusive when a redelivery was neither fulfilled nor recognised", () => {
    const f = check("duplicate-webhook", delivered(1, 0, 1), runWith(resent));
    expect(f.verdict).toBe("inconclusive");
    expect(f.likelyFix).toMatch(/verifying signatures/i);
  });

  it("treats a malformed store record as no evidence", () => {
    const bad = [
      store({ deliveries: [{ eventId: EV, fulfilled: "2", duplicatesIgnored: 0, other: 0 } as never] }),
      store({ deliveries: [{ eventId: EV, fulfilled: -1, duplicatesIgnored: 0, other: 0 }] }),
      store({
        deliveries: [
          { eventId: EV, fulfilled: 1, duplicatesIgnored: 0, other: 0 },
          { eventId: EV, fulfilled: 1, duplicatesIgnored: 0, other: 0 },
        ],
      }),
      store({ deliveries: "lots" as never }),
    ];
    for (const s of bad) {
      expect(check("duplicate-webhook", s, runWith(resent)).verdict).toBe("inconclusive");
    }
  });

  // Not tested is not passed.
  it("is inconclusive when no resend completed", () => {
    const f = check(
      "duplicate-webhook",
      delivered(2),
      runWith([{ id: "o1", kind: "card_order", status: "succeeded" }]),
    );
    expect(f.verdict).toBe("inconclusive");
    expect(f.actual).toMatch(/no resend step completed/i);
  });

  it("is inconclusive when the resend recorded no event id", () => {
    const noId: StepSpec[] = [
      { id: "o1", kind: "card_order", status: "succeeded" },
      { id: "dup", kind: "resend_webhook", status: "succeeded" },
    ];
    expect(check("duplicate-webhook", delivered(2), runWith(noId)).verdict).toBe("inconclusive");
  });

  it("keeps the finder waiting only while one more delivery could decide it", () => {
    const run = runWith(resent);
    expect(cls().settled!(delivered(0), run)).toBe(false);
    expect(cls().settled!(delivered(1), run)).toBe(false);
    expect(cls().settled!(delivered(2), run)).toBe(true);
    expect(cls().settled!(delivered(1, 1), run)).toBe(true);
    // Waiting cannot fix these, so it does not wait for them.
    expect(cls().settled!(store(), run)).toBe(true);
    expect(cls().settled!(delivered(1), runWith([]))).toBe(true);
  });
});

describe("refund-after-partial", () => {
  const two: StepSpec[] = [
    { id: "r1", kind: "refund", status: "succeeded" },
    { id: "r2", kind: "refund", status: "succeeded" },
  ];

  it("flags the store recording more refunds than happened", () => {
    const f = check(
      "refund-after-partial",
      store({ orders: [order({ refundCount: 3 })] }),
      runWith(two),
    );
    expect(f.verdict).toBe("bug");
    expect(f.likelyFix).toMatch(/dedupe refund events/i);
  });

  it("flags a refund that never reached the store", () => {
    const f = check(
      "refund-after-partial",
      store({ orders: [order({ refundCount: 1 })] }),
      runWith(two),
    );
    expect(f.verdict).toBe("bug");
    expect(f.actual).toMatch(/never reached it/i);
  });

  it("passes when the ledger matches what PayPal accepted", () => {
    const f = check(
      "refund-after-partial",
      store({ orders: [order({ refundCount: 1 })] }),
      runWith([
        { id: "r1", kind: "refund", status: "succeeded" },
        { id: "r2", kind: "refund", status: "failed", detail: "http 422" },
      ]),
    );
    expect(f.verdict).toBe("ok");
    expect(f.actual).toMatch(/refused any over-refund/i);
  });

  it("is inconclusive with fewer than two refunds planned", () => {
    expect(
      check("refund-after-partial", store(), runWith([{ id: "r1", kind: "refund" }])).verdict,
    ).toBe("inconclusive");
  });
});

describe("unclaimed-payout", () => {
  it("passes when the item reached UNCLAIMED", () => {
    const f = check(
      "unclaimed-payout",
      store(),
      runWith([{ id: "p1", kind: "payout_batch", status: "succeeded", detail: "items UNCLAIMED" }]),
    );
    expect(f.verdict).toBe("ok");
  });

  it("flags an item that settled instead, and says why", () => {
    const f = check(
      "unclaimed-payout",
      store(),
      runWith([
        { id: "p1", kind: "payout_batch", status: "failed", detail: "item 1 is SUCCESS" },
      ]),
    );
    expect(f.verdict).toBe("bug");
    expect(f.likelyFix).toMatch(/example\.com/);
  });

  it("is inconclusive with no payout planned", () => {
    expect(check("unclaimed-payout", store(), runWith([])).verdict).toBe("inconclusive");
  });
});

describe("overdue-invoice", () => {
  it("passes when the sent invoice reads overdue", () => {
    const f = check(
      "overdue-invoice",
      store(),
      runWith([
        { id: "s1", kind: "invoice_send", status: "succeeded", detail: "UNPAID and past its due date, so it reads as overdue" },
      ]),
    );
    expect(f.verdict).toBe("ok");
  });

  it("flags an invoice that is not overdue and explains how PayPal decides", () => {
    const f = check(
      "overdue-invoice",
      store(),
      runWith([{ id: "s1", kind: "invoice_send", status: "succeeded", detail: "invoice UNPAID" }]),
    );
    expect(f.verdict).toBe("bug");
    expect(f.likelyFix).toMatch(/computes overdue from the due date/i);
  });

  it("is inconclusive when nothing was sent", () => {
    expect(check("overdue-invoice", store(), runWith([])).verdict).toBe("inconclusive");
  });
});
