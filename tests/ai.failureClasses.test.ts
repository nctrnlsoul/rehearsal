import { describe, expect, it } from "vitest";
import { type RunState, initRunState, recordOutcome } from "../src/core/runState";
import { FAILURE_CLASSES, type StoreSnapshot, classById, judge } from "../src/ai/failureClasses";
import { DUE_DATE_UNREAD, NOT_PAST_DUE, READS_OVERDUE } from "../src/executor/handlers/invoice";
import { ITEM_STATUS_MISMATCH } from "../src/executor/handlers/payout";

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
  // Shown in the finder report and the console, so it is in US spelling (R-033).
  it("titles the class in US spelling", () => {
    expect(classById("duplicate-webhook")!.title).toBe("A redelivered capture event fulfills the order twice");
  });

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

  it("is ok when the second delivery was recognized and ignored", () => {
    const f = check("duplicate-webhook", delivered(1, 1), runWith(resent));
    expect(f.verdict).toBe("ok");
    expect(f.actual).toContain("recognized and ignored");
    expect(f.actual).toBe(`event ${EV} was fulfilled once and its 1 redelivery was recognized and ignored`);
    const two = check("duplicate-webhook", delivered(1, 2), runWith(resent));
    expect(two.actual).toBe(`event ${EV} was fulfilled once and its 2 redeliveries were recognized and ignored`);
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

  it("is inconclusive when a redelivery was neither fulfilled nor recognized", () => {
    const f = check("duplicate-webhook", delivered(1, 0, 1), runWith(resent));
    expect(f.verdict).toBe("inconclusive");
    expect(f.likelyFix).toMatch(/verifying signatures/i);
  });

  // A refused resend must be visible, not mistaken for one that never came.
  it("names why a redelivery was refused", () => {
    const s = store({
      deliveries: [
        {
          eventId: EV,
          fulfilled: 1,
          duplicatesIgnored: 0,
          other: 1,
          refusalReasons: ["paypal-cert-url host certs.evil.test is not paypal.com"],
        },
      ],
    });
    const f = check("duplicate-webhook", s, runWith(resent));
    expect(f.verdict).toBe("inconclusive");
    expect(f.actual).toContain("refused for this event: paypal-cert-url host certs.evil.test is not paypal.com");
  });

  it("mentions refusals with no event id from the same window", () => {
    const s = store({
      deliveries: [{ eventId: EV, fulfilled: 1, duplicatesIgnored: 0, other: 0 }],
      unattributedRefusals: { count: 2, reasons: ["body is not JSON"] },
    });
    const f = check("duplicate-webhook", s, runWith(resent));
    expect(f.verdict).toBe("inconclusive");
    expect(f.actual).toContain("2 refused request(s) with no event id in the same window: body is not JSON");
    expect(f.likelyFix).toMatch(/refusal reasons/);
  });

  it("never lets refusal text decide a verdict, or reach the terminal raw", () => {
    const s = store({
      deliveries: [
        {
          eventId: EV,
          fulfilled: 1,
          duplicatesIgnored: 0,
          other: 0,
          refusalReasons: ["\u001b[2Jok", 42 as never],
        },
      ],
      unattributedRefusals: { count: "lots" as never, reasons: [] },
    });
    const f = check("duplicate-webhook", s, runWith(resent));
    expect(f.verdict).toBe("inconclusive");
    expect(f.actual).not.toMatch(/\u001b/);
    expect(f.actual).toContain("refused for this event: [2Jok)");
    expect(f.actual).not.toContain("no event id");
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
    { id: "r1", kind: "refund", status: "succeeded", ids: { refund_id: "RF-1" } },
    { id: "r2", kind: "refund", status: "succeeded", ids: { refund_id: "RF-2" } },
  ];
  // The store files a refund event under the refund id, its resource id.
  const refundRow = (refundId: string, refundCount: unknown) =>
    order({ captureId: refundId, fulfilmentCount: 0, refundCount: refundCount as number });
  const recorded = (...rows: ReturnType<typeof order>[]) => store({ orders: rows });
  const cls = () => classById("refund-after-partial")!;

  it("is a bug when one accepted refund was recorded twice", () => {
    const f = check(
      "refund-after-partial",
      recorded(refundRow("RF-1", 1), refundRow("RF-2", 2)),
      runWith(two),
    );
    expect(f.verdict).toBe("bug");
    expect(f.actual).toBe("refund RF-2 was recorded 2 times");
    expect(f.likelyFix).toMatch(/dedupe refund events/i);
  });

  it("is ok when each accepted refund was recorded exactly once", () => {
    const f = check(
      "refund-after-partial",
      recorded(refundRow("RF-1", 1), refundRow("RF-2", 1)),
      runWith(two),
    );
    expect(f.verdict).toBe("ok");
    expect(f.actual).toBe("2 refund(s) accepted and each recorded once");
  });

  // The false pass this replaces: the store never saw a second refund, so a
  // clean count for the first one said nothing about the class.
  it("is inconclusive, never ok, when PayPal refused the second refund", () => {
    const f = check(
      "refund-after-partial",
      recorded(refundRow("RF-1", 1)),
      runWith([
        { id: "r1", kind: "refund", status: "succeeded", ids: { refund_id: "RF-1" } },
        { id: "r2", kind: "refund", status: "failed", detail: "http 422" },
      ]),
    );
    expect(f.verdict).toBe("inconclusive");
    expect(f.actual).toMatch(/PayPal refused 1 of the 2 refund\(s\) itself, so a second refund after a partial one never happened/);
  });

  it("is still a bug when PayPal refused one refund but another was recorded twice", () => {
    const f = check(
      "refund-after-partial",
      recorded(refundRow("RF-1", 2)),
      runWith([
        { id: "r1", kind: "refund", status: "succeeded", ids: { refund_id: "RF-1" } },
        { id: "r2", kind: "refund", status: "failed", detail: "http 422" },
      ]),
    );
    expect(f.verdict).toBe("bug");
  });

  // The false bug this replaces: a refund event still in flight was read as
  // one the store never got.
  it("is inconclusive, never ok or bug, when a refund has not reached the store", () => {
    const f = check("refund-after-partial", recorded(refundRow("RF-1", 1)), runWith(two));
    expect(f.verdict).toBe("inconclusive");
    expect(f.actual).toMatch(/^1 of 2 accepted refund\(s\) had reached the store.*missing: RF-2/);
  });

  it("is inconclusive when the store recorded none of them", () => {
    expect(check("refund-after-partial", store(), runWith(two)).verdict).toBe("inconclusive");
  });

  // The false pass this replaces: NaN compared false both ways and fell through to ok.
  it("treats a missing or non-numeric count as no evidence", () => {
    const bad = [
      recorded(refundRow("RF-1", 1), refundRow("RF-2", Number.NaN)),
      recorded(refundRow("RF-1", 1), refundRow("RF-2", "1")),
      recorded(refundRow("RF-1", 1), refundRow("RF-2", undefined)),
      recorded(refundRow("RF-1", 1), refundRow("RF-2", -1)),
      recorded(refundRow("RF-1", 1), refundRow("RF-2", 1.5)),
      recorded(refundRow("RF-1", 1), refundRow("RF-2", 1), refundRow("RF-2", 1)),
    ];
    for (const s of bad) {
      const f = check("refund-after-partial", s, runWith(two));
      expect(f.verdict).toBe("inconclusive");
      expect(f.actual).toMatch(/refund RF-2 is malformed/);
    }
  });

  it("counts only this run's refund ids, not other refunds in the window", () => {
    const f = check(
      "refund-after-partial",
      recorded(refundRow("RF-1", 1), refundRow("RF-2", 1), refundRow("RF-OTHER", 5)),
      runWith(two),
    );
    expect(f.verdict).toBe("ok");
  });

  it("is inconclusive when a refund ended unknown, since the count to expect is unknown", () => {
    const f = check(
      "refund-after-partial",
      recorded(refundRow("RF-1", 1)),
      runWith([
        { id: "r1", kind: "refund", status: "succeeded", ids: { refund_id: "RF-1" } },
        { id: "r2", kind: "refund", status: "unknown" },
      ]),
    );
    expect(f.verdict).toBe("inconclusive");
    expect(f.actual).toMatch(/r2 ended unknown/);
  });

  it("is inconclusive when an accepted refund recorded no refund id", () => {
    const f = check(
      "refund-after-partial",
      recorded(refundRow("RF-1", 1)),
      runWith([
        { id: "r1", kind: "refund", status: "succeeded", ids: { refund_id: "RF-1" } },
        { id: "r2", kind: "refund", status: "succeeded" },
      ]),
    );
    expect(f.verdict).toBe("inconclusive");
    expect(f.actual).toMatch(/r2 recorded no refund id/);
  });

  it("is inconclusive when PayPal accepted no refund at all", () => {
    const f = check(
      "refund-after-partial",
      store(),
      runWith([
        { id: "r1", kind: "refund", status: "failed" },
        { id: "r2", kind: "refund", status: "failed" },
      ]),
    );
    expect(f.verdict).toBe("inconclusive");
  });

  it("is inconclusive with fewer than two refunds planned", () => {
    expect(
      check("refund-after-partial", store(), runWith([{ id: "r1", kind: "refund" }])).verdict,
    ).toBe("inconclusive");
  });

  it("keeps the finder waiting only while a missing refund could still arrive", () => {
    const run = runWith(two);
    expect(cls().settled!(store(), run)).toBe(false);
    expect(cls().settled!(recorded(refundRow("RF-1", 1)), run)).toBe(false);
    expect(cls().settled!(recorded(refundRow("RF-1", 1), refundRow("RF-2", 1)), run)).toBe(true);
    expect(cls().settled!(recorded(refundRow("RF-2", 2)), run)).toBe(true);
    // Waiting cannot fix these, so it does not wait for them.
    expect(cls().settled!(recorded(refundRow("RF-1", 1), refundRow("RF-2", Number.NaN)), run)).toBe(true);
    expect(cls().settled!(store(), runWith([]))).toBe(true);
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

  it("flags an item PayPal settled as something else, and says why", () => {
    const f = check(
      "unclaimed-payout",
      store(),
      runWith([
        {
          id: "p1",
          kind: "payout_batch",
          status: "failed",
          detail: `${ITEM_STATUS_MISMATCH}: item 1 is SUCCESS, expected UNCLAIMED`,
        },
      ]),
    );
    expect(f.verdict).toBe("bug");
    expect(f.likelyFix).toMatch(/example\.com/);
  });

  // The false bugs this replaces: no item was ever observed in these runs.
  it("is inconclusive, never a bug, when PayPal refused the batch", () => {
    const f = check(
      "unclaimed-payout",
      store(),
      runWith([
        {
          id: "p1",
          kind: "payout_batch",
          status: "failed",
          detail: "payout batch not accepted: http 403, NOT_AUTHORIZED (Payouts not enabled)",
        },
      ]),
    );
    expect(f.verdict).toBe("inconclusive");
    expect(f.actual).toMatch(/p1 ended failed before PayPal reported how the item settled: .*http 403/);
  });

  it("is inconclusive, never a bug, when the payout ended unknown", () => {
    const f = check(
      "unclaimed-payout",
      store(),
      runWith([{ id: "p1", kind: "payout_batch", status: "unknown", detail: "still has PENDING items" }]),
    );
    expect(f.verdict).toBe("inconclusive");
  });

  it("is inconclusive, never ok, when the payout never ran", () => {
    const f = check("unclaimed-payout", store(), runWith([{ id: "p1", kind: "payout_batch" }]));
    expect(f.verdict).toBe("inconclusive");
    expect(f.actual).toBe("p1 never ran");
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
        { id: "s1", kind: "invoice_send", status: "succeeded", detail: `invoice UNPAID and past its due date of 2026-10-16, so it ${READS_OVERDUE}` },
      ]),
    );
    expect(f.verdict).toBe("ok");
  });

  it("flags an invoice PayPal reads as not past due and explains how PayPal decides", () => {
    const f = check(
      "overdue-invoice",
      store(),
      runWith([{ id: "s1", kind: "invoice_send", status: "succeeded", detail: `invoice UNPAID, due 2026-11-30, ${NOT_PAST_DUE}` }]),
    );
    expect(f.verdict).toBe("bug");
    expect(f.likelyFix).toMatch(/computes overdue from the due date/i);
  });

  // The false bug this replaces: the create failed, the send stayed pending,
  // and "not overdue" was read off a step that never ran.
  it("is inconclusive, never a bug, when the create failed and the send never ran", () => {
    const f = check(
      "overdue-invoice",
      store(),
      runWith([
        { id: "invoice", kind: "invoice_create", status: "failed", detail: "invoicing refused with http 403" },
        { id: "send", kind: "invoice_send" },
      ]),
    );
    expect(f.verdict).toBe("inconclusive");
    expect(f.actual).toMatch(/send never ran; invoice ended failed: invoicing refused with http 403/);
  });

  it("is inconclusive, never a bug, when the send failed or ended unknown", () => {
    for (const status of ["failed", "unknown"] as const) {
      const f = check(
        "overdue-invoice",
        store(),
        runWith([{ id: "s1", kind: "invoice_send", status, detail: "send failed: http 500" }]),
      );
      expect(f.verdict).toBe("inconclusive");
    }
  });

  it("is inconclusive when the sent invoice's due date could not be read", () => {
    const f = check(
      "overdue-invoice",
      store(),
      runWith([{ id: "s1", kind: "invoice_send", status: "succeeded", detail: `invoice UNPAID; ${DUE_DATE_UNREAD}` }]),
    );
    expect(f.verdict).toBe("inconclusive");
  });

  it("is inconclusive when nothing was sent", () => {
    expect(check("overdue-invoice", store(), runWith([])).verdict).toBe("inconclusive");
  });
});

// Junk or a busy window can push rows past the store's row cap. A cut window
// may be missing the very rows a verdict counts, so it gives no verdict.
describe("judge on a truncated store window", () => {
  const resent: StepSpec[] = [
    { id: "o1", kind: "card_order", status: "succeeded" },
    { id: "r1", kind: "resend_webhook", status: "succeeded", ids: { resent_event_id: "WH-1" } },
  ];
  const okStore = (truncated?: boolean) =>
    store({
      deliveries: [{ eventId: "WH-1", fulfilled: 1, duplicatesIgnored: 1, other: 0 }],
      ...(truncated === undefined ? {} : { truncated }),
    });

  it("passes a whole window's verdict through", () => {
    const cls = classById("duplicate-webhook")!;
    expect(judge(cls, okStore(), runWith(resent)).verdict).toBe("ok");
    expect(judge(cls, okStore(false), runWith(resent)).verdict).toBe("ok");
  });

  it("turns any verdict on a cut window into inconclusive, and says why", () => {
    const f = judge(classById("duplicate-webhook")!, okStore(true), runWith(resent));
    expect(f.verdict).toBe("inconclusive");
    expect(f.actual).toMatch(/more verified rows than it returns.*would have read: ok/);
  });
});
