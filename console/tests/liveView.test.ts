import { describe, expect, it } from "vitest";
import { type LiveEvent, type LiveRead, liveView, mergeEvents } from "../lib/liveView";

const T = (s: number) => new Date(Date.parse("2026-10-25T18:00:00Z") + s * 1000).toISOString();
let seq = 0;
const ev = (s: number, kind: string, step_id: string | null = null, data: Record<string, unknown> = {}): LiveEvent => ({ seq: ++seq, at: T(s), kind, step_id, data });

const read = (status: string, events: LiveEvent[], over: Partial<LiveRead["run"]> = {}, nowS = 60): LiveRead => ({
  run: {
    id: "20261025180000-aaaaaa",
    kind: "scenario",
    plan_source: "recorded",
    plan_id: "plan-x",
    scenario_sha256: "a".repeat(64),
    status,
    state: null,
    halt_reason: null,
    created_at: T(-1),
    started_at: status === "queued" ? null : T(0),
    heartbeat_at: T(nowS - 2),
    finished_at: null,
    ...over,
  },
  events,
  now: T(nowS),
});

const order = (s: number, capture: string) => ev(s, "note", null, { order: { capture_id: capture, fulfilled: 1, refunds: 0, disputes: 0, duplicates_ignored: 0 } });

describe("liveView", () => {
  // A store deployed before R-044 reports no capture ids per delivery.
  it("falls back to the store's order for the same capture, and labels the latency as an upper bound", () => {
    const v = liveView(
      read("running", [
        ev(0, "run_started"),
        ev(1, "step_started", "order", { kind: "card_order" }),
        ev(4, "step_finished", "order", { kind: "card_order", status: "succeeded", detail: "captured", ids: { capture_id: "CAP-1", order_id: "O-1" } }),
        order(21, "CAP-1"),
      ]),
    );
    expect(v.phase).toBe("running");
    expect(v.calls).toHaveLength(1);
    expect(v.pairs).toEqual([{ callKey: "c:order", deliveryKey: "d:order:CAP-1", what: "the capture's delivery", callT: 4, arrivedT: 21, exact: false }]);
    expect(v.deliveries[0]).toMatchObject({ pair: "c:order", title: "PAYMENT.CAPTURE.COMPLETED", received: false });
    expect(v.pairs[0]!.exact).toBe(false);
    expect(Math.round(v.pairs[0]!.arrivedT! - v.pairs[0]!.callT)).toBe(17);
  });

  it("shows a pair as waiting while its delivery has not been seen", () => {
    const v = liveView(
      read("running", [
        ev(1, "step_started", "order", { kind: "card_order" }),
        ev(4, "step_finished", "order", { kind: "card_order", status: "succeeded", ids: { capture_id: "CAP-1" } }),
      ]),
    );
    expect(v.pairs[0]!.arrivedT).toBeNull();
    expect(v.deliveries).toEqual([]);
  });

  it("never pairs an order with a different capture, or a failed call", () => {
    const v = liveView(
      read("running", [
        ev(1, "step_started", "a", { kind: "card_order" }),
        ev(4, "step_finished", "a", { kind: "card_order", status: "succeeded", ids: { capture_id: "CAP-1" } }),
        ev(5, "step_started", "b", { kind: "card_order" }),
        ev(6, "step_finished", "b", { kind: "card_order", status: "failed", ids: { capture_id: "CAP-2" } }),
        order(20, "CAP-OTHER"),
        order(21, "CAP-2"),
      ]),
    );
    expect(v.pairs.map((p) => [p.callKey, p.arrivedT])).toEqual([["c:a", null]]);
  });

  it("pairs a resend with the second delivery of the event it resent, not the first", () => {
    const delivery = (s: number, n: number) =>
      ev(s, "delivery", null, { event_id: "WH-1", event_type: "PAYMENT.CAPTURE.COMPLETED", deliveries: n, fulfilled: 1, duplicates_ignored: n - 1, other: 0, cert_hosts: ["api.sandbox.paypal.com"] });
    const base = [
      ev(10, "step_started", "resend", { kind: "resend_webhook" }),
      delivery(12, 1),
      ev(40, "step_finished", "resend", { kind: "resend_webhook", status: "succeeded", ids: { resent_event_id: "WH-1" } }),
    ];
    const waiting = liveView(read("running", base));
    expect(waiting.pairs[0]!.arrivedT).toBeNull();
    const arrived = liveView(read("running", [...base, delivery(70, 2)], {}, 80));
    expect(arrived.pairs[0]!.arrivedT).toBe(70);
    expect(arrived.deliveries[0]!.facts).toContainEqual(["store", "duplicate_ignored"]);
    expect(arrived.pairs[0]!.exact).toBe(false);
    expect(arrived.ledger).toEqual([
      { eventId: "WH-1", eventType: "PAYMENT.CAPTURE.COMPLETED", deliveries: 2, fulfilled: 1, duplicatesIgnored: 1, refused: 0, certHosts: ["api.sandbox.paypal.com"], firstSeenT: 12, firstReceivedT: null, joinedTo: ["resend"] },
    ]);
  });

  it("puts every delivery in the ledger, matched or not", () => {
    const v = liveView(read("running", [ev(30, "delivery", null, { event_id: "WH-INV", event_type: "INVOICING.INVOICE.PAID", deliveries: 1, fulfilled: 0, duplicates_ignored: 0, other: 1 })]));
    expect(v.pairs).toEqual([]);
    expect(v.ledger.map((l) => l.eventId)).toEqual(["WH-INV"]);
  });

  it("counts down the delivery wait, then says what was not seen without calling it missing", () => {
    const events = [
      ev(1, "step_started", "order", { kind: "card_order" }),
      ev(4, "step_finished", "order", { kind: "card_order", status: "succeeded", ids: { capture_id: "CAP-1" } }),
      ev(5, "deliveries_wait_started", null, { seconds: 90 }),
    ];
    const waiting = liveView(read("running", events, {}, 35));
    expect(waiting.phase).toBe("waiting");
    expect(waiting.waitLeftS).toBe(60);
    const done = liveView(read("complete", [...events, ev(95, "deliveries_wait_ended", null, { events_seen: 0 }), ev(96, "run_finished")], { finished_at: T(96) }, 100));
    expect(done.phase).toBe("complete");
    expect(done.settled).toBe(true);
    expect(done.detail).toContain("1 expected delivery was not seen when the 90 s wait ended");
    expect(done.detail).toContain("not proof");
  });

  it("shows a step in flight while running, and as never confirmed once the run is abandoned", () => {
    const events = [ev(1, "step_started", "d1", { kind: "open_dispute" })];
    expect(liveView(read("running", events)).calls[0]!.status).toBe("in-flight");
    const dead = liveView(read("abandoned", events, { halt_reason: "the server running this stopped; a step it had started may have written to PayPal" }));
    expect(dead.phase).toBe("abandoned");
    expect(dead.settled).toBe(true);
    expect(dead.calls[0]!.status).toBe("never-confirmed");
    expect(dead.calls[0]!.detail).toContain("may have written to PayPal");
    expect(dead.detail).toContain("may have written to PayPal");
  });

  it("reads queued, halted and failed runs, and reports how long since the last contact", () => {
    expect(liveView(read("queued", [])).phase).toBe("queued");
    const halted = liveView(read("halted", [], { halt_reason: "step d1 failed: the hosted purchase bank has no purchase ready to dispute" }));
    expect(halted.headline).toContain("Stopped");
    expect(halted.detail).toContain("no purchase ready");
    expect(liveView(read("failed", [])).settled).toBe(true);
    expect(liveView(read("running", [], {}, 60)).lastContactS).toBe(2);
  });

  it("treats an unknown status as failed, never as running", () => {
    expect(liveView(read("weird", [])).phase).toBe("failed");
  });

  it("notes when the store could not be read", () => {
    expect(liveView(read("running", [ev(5, "note", null, { store_read_failed: "TypeError" })])).storeUnread).toBe(true);
  });

  it("merges pages of events by sequence number, without duplicates", () => {
    const a = ev(1, "run_started");
    const b = ev(2, "note");
    const c = ev(3, "note");
    expect(mergeEvents([a, b], [b, c]).map((e) => e.seq)).toEqual([a.seq, b.seq, c.seq]);
  });
});

// R-044: the store reports the ids it recorded for each delivery and when it
// received each copy, so a delivery joins the one call that names it, exactly.
describe("liveView exact pairs (R-044)", () => {
  const finished = (s: number, step: string, kind: string, ids: Record<string, string>, extra: Record<string, unknown> = {}) =>
    ev(s, "step_finished", step, { kind, status: "succeeded", ids, ...extra });
  const call = (s: number, step: string, kind: string, ids: Record<string, string>, extra: Record<string, unknown> = {}) => [
    ev(s - 1, "step_started", step, { kind }),
    finished(s, step, kind, ids, extra),
  ];
  const delivery = (s: number, eventId: string, type: string, captureIds: string[], receivedS: number[], over: Record<string, unknown> = {}) =>
    ev(s, "delivery", null, {
      event_id: eventId,
      event_type: type,
      deliveries: receivedS.length,
      fulfilled: type === "PAYMENT.CAPTURE.COMPLETED" ? 1 : 0,
      duplicates_ignored: Math.max(0, receivedS.length - 1),
      other: type === "PAYMENT.CAPTURE.COMPLETED" ? 0 : 1,
      refused: 0,
      cert_hosts: [],
      capture_ids: captureIds,
      received_at: receivedS.map(T),
      ...over,
    });

  it("joins a capture's delivery to its card order at the store's receive time, from the engine's finish time", () => {
    const v = liveView(
      read("running", [
        ...call(5, "order", "card_order", { capture_id: "CAP-1", order_id: "O-1" }, { finished_at: T(4.2) }),
        // Seen on the 15 s poll; received at 11.6 s by the store's own clock.
        delivery(15, "WH-1", "PAYMENT.CAPTURE.COMPLETED", ["CAP-1"], [11.6]),
      ]),
    );
    expect(v.calls[0]!.t).toBeCloseTo(4.2, 3);
    expect(v.pairs).toEqual([{ callKey: "c:order", deliveryKey: "d:event:WH-1", what: "the capture's delivery", callT: v.calls[0]!.t, arrivedT: expect.closeTo(11.6, 3), exact: true }]);
    expect(v.pairs[0]!.exact).toBe(true);
    expect(Math.round(v.pairs[0]!.arrivedT! - v.pairs[0]!.callT)).toBe(7);
    expect(v.deliveries).toEqual([
      { key: "d:event:WH-1", pair: "c:order", t: expect.closeTo(11.6, 3), at: T(11.6), title: "PAYMENT.CAPTURE.COMPLETED", facts: [["event", "WH-1"], ["capture", "CAP-1"], ["store", "fulfilled"]], received: true },
    ]);
    expect(v.ledger[0]).toMatchObject({ eventId: "WH-1", firstSeenT: 15, firstReceivedT: expect.closeTo(11.6, 3), joinedTo: ["order"] });
  });

  it("uses the save's time for a call when the engine's finish time is missing or not a time", () => {
    const v = liveView(read("running", [...call(5, "a", "card_order", { capture_id: "CAP-1" }, { finished_at: "soon" })]));
    expect(v.calls[0]!.t).toBe(5);
  });

  it("joins an invoice's creation and payment to their own steps, through the step the payment came from, and leaves an update unjoined", () => {
    const v = liveView(
      read("running", [
        ...call(3, "inv", "invoice_create", { invoice_id: "INV2-1", invoice_number: "R-1" }),
        ...call(6, "send", "invoice_send", {}, { from: "inv" }),
        ...call(9, "pay", "invoice_record_payment", { invoice_payment_id: "PAY-1" }, { from: "inv" }),
        delivery(20, "WH-C", "INVOICING.INVOICE.CREATED", ["INV2-1"], [5]),
        delivery(20, "WH-U", "INVOICING.INVOICE.UPDATED", ["INV2-1"], [8]),
        delivery(25, "WH-P", "INVOICING.INVOICE.PAID", ["INV2-1"], [12]),
      ]),
    );
    expect(v.pairs.map((p) => [p.callKey, p.deliveryKey, p.exact])).toEqual([
      ["c:inv", "d:event:WH-C", true],
      ["c:pay", "d:event:WH-P", true],
    ]);
    expect(Object.fromEntries(v.ledger.map((l) => [l.eventId, l.joinedTo]))).toEqual({ "WH-C": ["inv"], "WH-U": [], "WH-P": ["pay"] });
    expect(v.deliveries.find((d) => d.key === "d:event:WH-P")!.facts).toContainEqual(["id", "INV2-1"]);
  });

  it("never guesses: a delivery two calls could have caused stays unjoined", () => {
    const v = liveView(
      read("running", [
        ...call(3, "inv", "invoice_create", { invoice_id: "INV2-1" }),
        ...call(6, "pay1", "invoice_record_payment", {}, { from: "inv" }),
        ...call(9, "pay2", "invoice_record_payment", {}, { from: "inv" }),
        delivery(20, "WH-P", "INVOICING.INVOICE.PAID", ["INV2-1"], [12]),
      ]),
    );
    expect(v.pairs).toEqual([]);
    expect(v.ledger[0]!.joinedTo).toEqual([]);
  });

  it("joins a refund and a dispute by the ids the store records for them", () => {
    const v = liveView(
      read("running", [
        ...call(3, "order", "card_order", { capture_id: "CAP-1" }),
        ...call(6, "refund", "refund", { refund_id: "REF-1" }, { from: "order" }),
        ...call(9, "dispute", "open_dispute", { dispute_id: "PP-D-1", purchase_capture_id: "CAP-OLD" }),
        delivery(20, "WH-R", "PAYMENT.CAPTURE.REFUNDED", ["REF-1"], [8]),
        delivery(30, "WH-D", "CUSTOMER.DISPUTE.CREATED", ["PP-D-1"], [25]),
      ]),
    );
    expect(v.pairs.filter((p) => p.exact).map((p) => [p.callKey, p.deliveryKey])).toEqual([
      ["c:refund", "d:event:WH-R"],
      ["c:dispute", "d:event:WH-D"],
    ]);
  });

  it("never joins on a matching id with the wrong event type, a failed call, or a refused-only delivery", () => {
    const v = liveView(
      read("running", [
        ...call(3, "inv", "invoice_create", { invoice_id: "INV2-1" }),
        ev(5, "step_started", "bad", { kind: "card_order" }),
        ev(6, "step_finished", "bad", { kind: "card_order", status: "failed", ids: { capture_id: "CAP-9" } }),
        // A capture event naming an invoice id, and a delivery for the failed call's capture.
        delivery(20, "WH-X", "PAYMENT.CAPTURE.COMPLETED", ["INV2-1"], [10]),
        delivery(20, "WH-Y", "PAYMENT.CAPTURE.COMPLETED", ["CAP-9"], [11]),
        // The store reports no ids for a delivery it refused.
        delivery(20, "WH-Z", "INVOICING.INVOICE.CREATED", [], [], { refused: 1 }),
      ]),
    );
    expect(v.pairs).toEqual([]);
    expect(v.ledger.every((l) => l.joinedTo.length === 0)).toBe(true);
  });

  it("joins a resend to its event's second receive time, and the original to its card order", () => {
    const v = liveView(
      read("running", [
        ...call(4, "order", "card_order", { capture_id: "CAP-1" }),
        delivery(10, "WH-1", "PAYMENT.CAPTURE.COMPLETED", ["CAP-1"], [7]),
        ...call(40, "resend", "resend_webhook", { resent_event_id: "WH-1" }),
        delivery(50, "WH-1", "PAYMENT.CAPTURE.COMPLETED", ["CAP-1"], [7, 43.4]),
      ], {}, 60),
    );
    expect(v.pairs.map((p) => [p.callKey, p.deliveryKey, Math.round(p.arrivedT! * 10) / 10, p.exact])).toEqual([
      ["c:order", "d:event:WH-1", 7, true],
      ["c:resend", "d:redelivery:WH-1", 43.4, true],
    ]);
    expect(v.deliveries.find((d) => d.key === "d:redelivery:WH-1")).toMatchObject({ received: true, facts: [["event", "WH-1"], ["store", "duplicate_ignored"]] });
    // The original card shows what the store did with the first copy, not the later total.
    expect(v.deliveries.find((d) => d.key === "d:event:WH-1")!.facts).toContainEqual(["store", "fulfilled"]);
    expect(v.ledger[0]!.joinedTo).toEqual(["order", "resend"]);
  });

  it("still waits for a card order's capture delivery until one arrives", () => {
    const v = liveView(read("running", [...call(4, "order", "card_order", { capture_id: "CAP-1" })]));
    expect(v.pairs).toEqual([{ callKey: "c:order", deliveryKey: "d:order:CAP-1", what: "the capture's delivery", callT: 4, arrivedT: null, exact: false }]);
  });
});

describe("liveView finder verdicts", () => {
  it("reads the verdict, and anything unexpected as inconclusive", () => {
    const f = (verdict: unknown) =>
      liveView(read("complete", [ev(100, "note", null, { finding: { class_id: "overdue-invoice", verdict, title: "t", expected: "e", actual: "a", likely_fix: "f", skipped: null } })])).finding;
    expect(f("ok")).toMatchObject({ classId: "overdue-invoice", verdict: "ok", expected: "e" });
    expect(f("bug")!.verdict).toBe("bug");
    expect(f("OK")!.verdict).toBe("inconclusive");
    expect(f(undefined)!.verdict).toBe("inconclusive");
    expect(liveView(read("complete", [])).finding).toBeNull();
  });
});
