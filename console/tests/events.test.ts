import { describe, expect, it } from "vitest";
import type { RunState, StoreSnapshot } from "../lib/engine";
import { type SeenDeliveries, deliveryEvents, planFacts, stateEvents } from "../lib/events";
import { initRunState } from "../../src/core/runState";

/**
 * The timeline events the worker saves, from what the run saved and what the
 * store reported. Pure, so every bound is tested here.
 */

const SEEN_AT = "2026-10-25T18:00:15.000Z";

const snapshot = (deliveries: unknown[]): StoreSnapshot =>
  ({ orders: [], deliveries, eventCount: deliveries.length, unverifiedCount: 0 }) as unknown as StoreSnapshot;

const delivery = (over: Record<string, unknown> = {}) => ({
  eventId: "WH-1",
  eventType: "PAYMENT.CAPTURE.COMPLETED",
  fulfilled: 1,
  duplicatesIgnored: 0,
  other: 0,
  refused: 0,
  refusalReasons: [],
  certHosts: ["api.sandbox.paypal.com"],
  captureIds: ["CAP-1"],
  receivedAt: ["2026-10-25T18:00:11.600Z"],
  ...over,
});

describe("deliveryEvents (R-044)", () => {
  it("carries each delivery's capture ids and receive times", () => {
    const [e] = deliveryEvents(snapshot([delivery()]), new Map(), SEEN_AT);
    expect(e).toEqual({
      kind: "delivery",
      data: {
        event_id: "WH-1",
        event_type: "PAYMENT.CAPTURE.COMPLETED",
        deliveries: 1,
        fulfilled: 1,
        duplicates_ignored: 0,
        other: 0,
        refused: 0,
        cert_hosts: ["api.sandbox.paypal.com"],
        capture_ids: ["CAP-1"],
        received_at: ["2026-10-25T18:00:11.600Z"],
        seen_at: SEEN_AT,
      },
    });
  });

  it("keeps five of each, drops anything that is not an id or a real time, and re-writes times as ISO", () => {
    const [e] = deliveryEvents(
      snapshot([
        delivery({
          captureIds: ["A", 7, "", null, "B", "C", "D", "E", "F"],
          receivedAt: ["2026-10-25 18:00:07.125+00", "yesterday", 12, "2026-10-25T18:00:40.250Z", "x".repeat(60)],
        }),
      ]),
      new Map(),
      SEEN_AT,
    );
    expect(e!.data!["capture_ids"]).toEqual(["A", "B"]);
    expect(e!.data!["received_at"]).toEqual(["2026-10-25T18:00:07.125Z", "2026-10-25T18:00:40.250Z"]);
  });

  it("reports none from a store that does not send them, rather than failing", () => {
    const [e] = deliveryEvents(snapshot([delivery({ captureIds: undefined, receivedAt: "not a list" })]), new Map(), SEEN_AT);
    expect(e!.data).toMatchObject({ capture_ids: [], received_at: [] });
  });

  it("stays well inside the table's 4 KB event limit at every bound", () => {
    const long = "W".repeat(500);
    const [e] = deliveryEvents(
      snapshot([delivery({ eventId: long, eventType: long, certHosts: [long, long, long, long], captureIds: Array(9).fill(long), receivedAt: Array(9).fill("2026-10-25T18:00:11.600Z") })]),
      new Map(),
      SEEN_AT,
    );
    expect(Buffer.byteLength(JSON.stringify(e))).toBeLessThan(2048);
  });

  it("reports an event again only when its total grows, with the new receive time", () => {
    const seen: SeenDeliveries = new Map();
    expect(deliveryEvents(snapshot([delivery()]), seen, SEEN_AT)).toHaveLength(1);
    expect(deliveryEvents(snapshot([delivery()]), seen, SEEN_AT)).toHaveLength(0);
    const [again] = deliveryEvents(snapshot([delivery({ duplicatesIgnored: 1, receivedAt: ["2026-10-25T18:00:11.600Z", "2026-10-25T18:00:43.400Z"] })]), seen, SEEN_AT);
    expect(again!.data!["received_at"]).toEqual(["2026-10-25T18:00:11.600Z", "2026-10-25T18:00:43.400Z"]);
  });
});

const state = (steps: RunState["steps"]): RunState => ({
  version: 1,
  runId: "r",
  scenarioName: "s",
  currency: "USD",
  order: Object.keys(steps),
  startedAt: "2026-10-25T18:00:00.000Z",
  updatedAt: "2026-10-25T18:00:10.000Z",
  halted: false,
  haltReason: null,
  meta: {},
  steps,
});

const step = (id: string, kind: string, over: Partial<RunState["steps"][string]> = {}) => ({
  id,
  kind,
  status: "succeeded" as const,
  detail: "ok",
  ids: {},
  attempts: 1,
  startedAt: "2026-10-25T18:00:01.000Z",
  finishedAt: "2026-10-25T18:00:04.200Z",
  ...over,
});

describe("stateEvents (R-044)", () => {
  it("records when PayPal's answer came back, and the step a step acted on", () => {
    const s = state({ inv: step("inv", "invoice_create", { ids: { invoice_id: "INV2-1" } }), pay: step("pay", "invoice_record_payment") });
    const finishedOf = (events: ReturnType<typeof stateEvents>) => events.filter((e) => e.kind === "step_finished").map((e) => [e.step_id, e.data]);
    expect(finishedOf(stateEvents(null, s, new Map([["pay", "inv"]])))).toEqual([
      ["inv", { kind: "invoice_create", status: "succeeded", detail: "ok", ids: { invoice_id: "INV2-1" }, finished_at: "2026-10-25T18:00:04.200Z" }],
      ["pay", { kind: "invoice_record_payment", status: "succeeded", detail: "ok", ids: {}, finished_at: "2026-10-25T18:00:04.200Z", from: "inv" }],
    ]);
  });

  it("names no source when it is given none", () => {
    const [, finished] = stateEvents(null, state({ a: step("a", "card_order") }));
    expect(finished!.data).not.toHaveProperty("from");
  });
});

describe("planFacts", () => {
  it("names each step's kind and amount, and sums a payout's items in cents", () => {
    const facts = planFacts({
      currency: "USD",
      steps: [
        { id: "o1", kind: "card_order", amount: "45.00", needs: [] },
        { id: "p1", kind: "payout_batch", items: [{ amount: "10.10" }, { amount: "0.95" }], needs: [] },
        { id: "r1", kind: "refund", from: "o1", mode: "partial", basisPoints: 2500, needs: ["o1"] },
      ],
    });
    expect(facts).toEqual({
      currency: "USD",
      steps: [
        { id: "o1", kind: "card_order", amount: "45.00" },
        { id: "p1", kind: "payout_batch", amount: "11.05" },
        { id: "r1", kind: "refund", from: "o1", mode: "partial", basisPoints: 2500 },
      ],
    });
  });

  // An event over the 4 KB check would fail the first save, and with it the run.
  it("stays under the event size check however long the plan", () => {
    const steps = Array.from({ length: 30 }, (_, i) => ({ id: `step-${"x".repeat(40)}-${i}`, kind: "resend_webhook", from: "y".repeat(64), eventType: "Z".repeat(120), needs: [] }));
    const facts = planFacts({ currency: "USD", steps });
    expect(new TextEncoder().encode(JSON.stringify({ plan: facts })).length).toBeLessThanOrEqual(3000);
    expect(facts.steps.length).toBeGreaterThan(0);
  });

  it("is recorded once, with the first save only", () => {
    const plan = planFacts({ currency: "USD", steps: [{ id: "o1", kind: "card_order", amount: "1.00", needs: [] }] });
    const first = stateEvents(null, initRunState({ runId: "r", scenarioName: "s", currency: "USD", steps: [{ id: "o1", kind: "card_order" }], order: ["o1"], nowIso: "2026-11-07T00:00:00Z" }), new Map(), plan);
    expect(first.filter((e) => e.kind === "note" && "plan" in (e.data ?? {}))).toHaveLength(1);
  });
});
