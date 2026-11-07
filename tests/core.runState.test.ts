import { describe, expect, it } from "vitest";
import {
  type RunState,
  haltRun,
  initRunState,
  markInterrupted,
  markStarted,
  nextRunnableStep,
  recordMeta,
  recordOutcome,
  retryStep,
  summarize,
} from "../src/core/runState";

const T0 = "2026-10-23T00:00:00.000Z";
const T1 = "2026-10-23T00:00:01.000Z";

const steps = [
  { id: "a", kind: "card_order" },
  { id: "b", kind: "refund" },
  { id: "c", kind: "payout_batch" },
];

const needs = new Map<string, readonly string[]>([
  ["a", []],
  ["b", ["a"]],
  ["c", []],
]);

const fresh = (): RunState =>
  initRunState({
    runId: "run-1",
    scenarioName: "test",
    currency: "USD",
    steps,
    order: ["a", "b", "c"],
    nowIso: T0,
  });

describe("initRunState", () => {
  it("starts every step pending with no ids", () => {
    const s = fresh();
    expect(Object.keys(s.steps).sort()).toEqual(["a", "b", "c"]);
    expect(Object.values(s.steps).every((r) => r.status === "pending")).toBe(true);
    expect(s.halted).toBe(false);
    expect(summarize(s).complete).toBe(false);
  });
});

describe("nextRunnableStep", () => {
  it("returns the first pending step whose dependencies all succeeded", () => {
    let s = fresh();
    expect(nextRunnableStep(s, needs)).toBe("a");
    s = recordOutcome(s, "a", { kind: "success", detail: "ok" }, T1);
    expect(nextRunnableStep(s, needs)).toBe("b");
  });

  it("skips a step whose dependency has not run and takes a later ready one", () => {
    const s = fresh();
    const onlyB = new Map<string, readonly string[]>([
      ["a", ["c"]],
      ["b", ["a"]],
      ["c", []],
    ]);
    // a needs c, b needs a, so c is the only runnable step first.
    expect(nextRunnableStep(s, onlyB)).toBe("c");
  });

  it("returns null when everything has run", () => {
    let s = fresh();
    for (const id of ["a", "b", "c"]) {
      s = recordOutcome(s, id, { kind: "success", detail: "ok" }, T1);
    }
    expect(nextRunnableStep(s, needs)).toBeNull();
    expect(summarize(s).complete).toBe(true);
  });

  it("returns null once the run is halted, even if steps remain pending", () => {
    const s = haltRun(fresh(), "operator stopped it", T1);
    expect(nextRunnableStep(s, needs)).toBeNull();
    expect(s.haltReason).toContain("operator");
  });
});

describe("recordOutcome fails closed", () => {
  // The rule the whole executor rests on.
  it("halts the run on an unknown outcome", () => {
    const s = recordOutcome(fresh(), "a", { kind: "unknown", detail: "http 500 on capture" }, T1);
    expect(s.steps["a"]!.status).toBe("unknown");
    expect(s.halted).toBe(true);
    expect(s.haltReason).toMatch(/unknown state/i);
    expect(s.haltReason).toContain("http 500");
    expect(nextRunnableStep(s, needs)).toBeNull();
  });

  it("halts the run on a failure", () => {
    const s = recordOutcome(fresh(), "a", { kind: "failed", detail: "card declined" }, T1);
    expect(s.halted).toBe(true);
    expect(s.haltReason).toContain("card declined");
  });

  it("does not halt on success", () => {
    const s = recordOutcome(fresh(), "a", { kind: "success", detail: "ok" }, T1);
    expect(s.halted).toBe(false);
    expect(s.haltReason).toBeNull();
  });

  it("records ids and keeps earlier ones when a step reports twice", () => {
    let s = recordOutcome(fresh(), "a", { kind: "success", detail: "ok", ids: { order_id: "O1" } }, T1);
    s = recordOutcome(s, "a", { kind: "success", detail: "ok", ids: { capture_id: "C1" } }, T1);
    expect(s.steps["a"]!.ids).toEqual({ order_id: "O1", capture_id: "C1" });
  });

  it("ignores an unknown step id rather than inventing a record", () => {
    const s = recordOutcome(fresh(), "ghost", { kind: "success", detail: "ok" }, T1);
    expect(Object.keys(s.steps).sort()).toEqual(["a", "b", "c"]);
  });
});

describe("resume behaviour", () => {
  it("does not re-offer a step that already succeeded", () => {
    let s = fresh();
    s = recordOutcome(s, "a", { kind: "success", detail: "ok" }, T1);
    s = recordOutcome(s, "b", { kind: "success", detail: "ok" }, T1);
    expect(nextRunnableStep(s, needs)).toBe("c");
    expect(s.steps["a"]!.status).toBe("succeeded");
  });

  it("counts attempts across retries", () => {
    let s = markStarted(fresh(), "a", T1);
    s = markStarted(s, "a", T1);
    expect(s.steps["a"]!.attempts).toBe(2);
  });
});

// The double write this closes: a step marked started, then the process died
// before its outcome was saved. On resume it read as pending and ran again,
// which for a dispute draws a second banked purchase.
describe("a step that started and never finished", () => {
  const cutOff = () => markStarted(fresh(), "a", T1);

  it("is never offered to run again", () => {
    expect(nextRunnableStep(cutOff(), needs)).toBeNull();
  });

  it("becomes unknown on load, which halts the run", () => {
    const s = markInterrupted(cutOff(), T1);
    expect(s.steps["a"]!.status).toBe("unknown");
    expect(s.steps["a"]!.detail).toMatch(/started at .* never recorded an outcome, so it may have reached PayPal/);
    expect(s.halted).toBe(true);
    expect(nextRunnableStep(s, needs)).toBeNull();
  });

  it("leaves a run with nothing in flight untouched", () => {
    const s = recordOutcome(cutOff(), "a", { kind: "success", detail: "ok" }, T1);
    expect(markInterrupted(s, T1)).toBe(s);
    expect(markInterrupted(fresh(), T1)).toEqual(fresh());
  });

  it("runs again only after an explicit retry, which does not read as interrupted", () => {
    const r = retryStep(markInterrupted(cutOff(), T1), "a", T1);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.state.steps["a"]!.startedAt).toBeNull();
    expect(markInterrupted(r.state, T1)).toBe(r.state);
    expect(nextRunnableStep(r.state, needs)).toBe("a");
  });
});

describe("retryStep", () => {
  it("clears an unknown step back to pending and lifts the halt", () => {
    const halted = recordOutcome(fresh(), "a", { kind: "unknown", detail: "threw" }, T1);
    expect(halted.halted).toBe(true);
    const r = retryStep(halted, "a", T1);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.state.halted).toBe(false);
    expect(r.state.steps["a"]!.status).toBe("pending");
    expect(nextRunnableStep(r.state, needs)).toBe("a");
  });

  it("clears a failed step too", () => {
    const halted = recordOutcome(fresh(), "a", { kind: "failed", detail: "declined" }, T1);
    expect(retryStep(halted, "a", T1).ok).toBe(true);
  });

  // Never re-run a success: that is how a payment gets made twice.
  it("refuses to reset a step that already succeeded", () => {
    const done = recordOutcome(fresh(), "a", { kind: "success", detail: "ok" }, T1);
    const r = retryStep(done, "a", T1);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/duplicate a payment/i);
  });

  it("refuses an unknown step id or a step that never ran", () => {
    expect(retryStep(fresh(), "ghost", T1).ok).toBe(false);
    expect(retryStep(fresh(), "a", T1).ok).toBe(false);
  });
});

describe("recordMeta", () => {
  it("stores run-level ids that belong to no single step", () => {
    const s = recordMeta(fresh(), "webhook_id", "WH-1", T1);
    expect(s.meta).toEqual({ webhook_id: "WH-1" });
    expect(s.updatedAt).toBe(T1);
  });

  it("starts empty and accumulates", () => {
    expect(fresh().meta).toEqual({});
    const s = recordMeta(recordMeta(fresh(), "a", "1", T1), "b", "2", T1);
    expect(s.meta).toEqual({ a: "1", b: "2" });
  });
});

describe("summarize", () => {
  it("counts statuses and flattens every id in plan order", () => {
    let s = fresh();
    s = recordOutcome(s, "a", { kind: "success", detail: "ok", ids: { order_id: "O1", capture_id: "C1" } }, T1);
    s = recordOutcome(s, "c", { kind: "success", detail: "ok", ids: { batch_id: "B1" } }, T1);
    const sum = summarize(s);
    expect(sum.total).toBe(3);
    expect(sum.succeeded).toBe(2);
    expect(sum.pending).toBe(1);
    expect(sum.complete).toBe(false);
    expect(sum.ids.map((i) => i.value)).toEqual(["O1", "C1", "B1"]);
  });
});
