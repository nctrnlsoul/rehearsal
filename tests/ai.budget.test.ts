import { describe, expect, it } from "vitest";
import {
  AiBudgetTracker,
  BudgetExceededError,
  DEFAULT_AI_BUDGET,
  aiBudgetFromEnv,
} from "../src/ai/budget";

describe("AiBudgetTracker call cap", () => {
  it("allows exactly the permitted number of calls, then refuses", () => {
    const t = new AiBudgetTracker({ ...DEFAULT_AI_BUDGET, maxCallsPerRun: 2 });
    expect(t.beginCall()).toBe(1);
    expect(t.beginCall()).toBe(2);
    expect(t.callsRemaining).toBe(0);
    expect(() => t.beginCall()).toThrow(BudgetExceededError);
    try {
      t.beginCall();
    } catch (e) {
      expect((e as BudgetExceededError).code).toBe("calls-exhausted");
    }
  });

  it("counts remaining calls", () => {
    const t = new AiBudgetTracker({ ...DEFAULT_AI_BUDGET, maxCallsPerRun: 3 });
    expect(t.callsRemaining).toBe(3);
    t.beginCall();
    expect(t.callsRemaining).toBe(2);
  });
});

describe("AiBudgetTracker input cap", () => {
  // Untrusted text is sized before it reaches the model, not after.
  it("refuses input over the character limit", () => {
    const t = new AiBudgetTracker({ ...DEFAULT_AI_BUDGET, maxInputChars: 10 });
    expect(() => t.assertInputWithinLimit("x".repeat(11), "description")).toThrow(
      BudgetExceededError,
    );
    try {
      t.assertInputWithinLimit("x".repeat(11), "description");
    } catch (e) {
      expect((e as BudgetExceededError).code).toBe("input-too-large");
      expect((e as Error).message).toContain("description");
    }
  });

  it("allows input exactly at the limit", () => {
    const t = new AiBudgetTracker({ ...DEFAULT_AI_BUDGET, maxInputChars: 10 });
    expect(() => t.assertInputWithinLimit("x".repeat(10))).not.toThrow();
  });
});

describe("AiBudgetTracker usage accounting", () => {
  it("accumulates usage and tolerates missing fields", () => {
    const t = new AiBudgetTracker();
    t.recordUsage({ inputTokens: 100, outputTokens: 50 });
    t.recordUsage({ outputTokens: 25 });
    t.recordUsage({});
    expect(t.spent).toEqual({ calls: 0, inputTokens: 100, outputTokens: 75 });
  });

  it("summarises what it spent", () => {
    const t = new AiBudgetTracker({ ...DEFAULT_AI_BUDGET, maxCallsPerRun: 5 });
    t.beginCall();
    t.recordUsage({ inputTokens: 10, outputTokens: 20 });
    expect(t.summary()).toContain("1/5 calls");
    expect(t.summary()).toContain("10 in / 20 out");
  });
});

describe("aiBudgetFromEnv", () => {
  it("falls back to the defaults", () => {
    expect(aiBudgetFromEnv({})).toEqual(DEFAULT_AI_BUDGET);
  });

  it("reads overrides", () => {
    const b = aiBudgetFromEnv({
      REHEARSAL_AI_MAX_CALLS: "2",
      REHEARSAL_AI_MAX_OUTPUT_TOKENS: "500",
      REHEARSAL_AI_MAX_INPUT_CHARS: "80",
    });
    expect(b).toEqual({ maxCallsPerRun: 2, maxOutputTokensPerCall: 500, maxInputChars: 80 });
  });

  // A malformed budget must never silently widen the limit.
  it("throws rather than ignoring a malformed value", () => {
    for (const bad of ["0", "-1", "lots", "2.5", "1e3"]) {
      expect(() => aiBudgetFromEnv({ REHEARSAL_AI_MAX_CALLS: bad }), bad).toThrow();
    }
  });
});
