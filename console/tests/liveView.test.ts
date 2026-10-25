import { describe, expect, it } from "vitest";
import { type LiveEvent, type LiveRead, liveView, mergeEvents, withinLabel } from "../lib/liveView";

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
  it("pairs a card order with the store's order for the same capture, and labels the latency as an upper bound", () => {
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
    expect(v.pairs).toEqual([{ callKey: "c:order", deliveryKey: "d:order:CAP-1", what: "the store's order for this capture", callT: 4, arrivedT: 21 }]);
    expect(v.deliveries[0]).toMatchObject({ pair: "c:order", title: "PAYMENT.CAPTURE.COMPLETED" });
    expect(withinLabel(17.4)).toBe("within 17 s");
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
    expect(arrived.ledger).toEqual([
      { eventId: "WH-1", eventType: "PAYMENT.CAPTURE.COMPLETED", deliveries: 2, fulfilled: 1, duplicatesIgnored: 1, refused: 0, certHosts: ["api.sandbox.paypal.com"], firstSeenT: 12 },
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
