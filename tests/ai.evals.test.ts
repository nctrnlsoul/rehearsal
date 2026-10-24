import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { type EvalResult, evalReportLines, forbiddenIn, summariseEvals } from "../src/ai/evals";
import { STEP_KINDS } from "../src/core/scenario";

const result = (over: Partial<EvalResult>): EvalResult => ({
  id: "c",
  expect: "valid",
  outcome: "valid",
  refusedBy: "none",
  detail: "",
  ...over,
});

describe("the example descriptions file", () => {
  const raw = JSON.parse(
    readFileSync(resolve(import.meta.dirname, "../evals/descriptions.json"), "utf8"),
  ) as { cases: Array<{ id: string; expect: string; description: string; forbidKinds?: string[] }> };

  it("holds the 20 milestone descriptions plus the demo line", () => {
    expect(raw.cases).toHaveLength(21);
    expect(raw.cases.map((c) => c.description)).toContain("an open dispute waiting for my response");
  });

  it("forbids a card order on both dispute-only descriptions, and only real step kinds anywhere", () => {
    for (const id of ["soap-maker", "dispute-waiting"]) {
      expect(raw.cases.find((c) => c.id === id)?.forbidKinds).toEqual(["card_order"]);
    }
    for (const c of raw.cases) {
      for (const k of c.forbidKinds ?? []) expect(STEP_KINDS as readonly string[]).toContain(k);
    }
  });

  it("covers every unsafe category by name", () => {
    const unsafe = raw.cases.filter((c) => c.expect === "refused");
    expect(unsafe.length).toBeGreaterThanOrEqual(5);
    const text = unsafe.map((c) => c.description).join(" ").toLowerCase();
    expect(text).toContain("api-m.paypal.com");
    expect(text).toContain("500000.00");
    expect(text).toContain("attacker.example");
  });

  it("has unique ids and no blank descriptions", () => {
    const ids = raw.cases.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(raw.cases.every((c) => c.description.trim().length > 20)).toBe(true);
  });
});

describe("forbiddenIn", () => {
  it("names each forbidden kind present once, and nothing when the case forbids nothing", () => {
    expect(forbiddenIn(["card_order"], ["card_order", "card_order", "open_dispute"])).toEqual(["card_order"]);
    expect(forbiddenIn(["card_order"], ["open_dispute"])).toEqual([]);
    expect(forbiddenIn(undefined, ["card_order"])).toEqual([]);
  });
});

describe("summariseEvals", () => {
  it("scores the two rates separately", () => {
    const s = summariseEvals([
      result({ id: "a" }),
      result({ id: "b" }),
      result({ id: "c", outcome: "refused", refusedBy: "schema" }),
      result({ id: "d", expect: "refused", outcome: "refused", refusedBy: "caps" }),
      result({ id: "e", expect: "refused", outcome: "refused", refusedBy: "model" }),
    ]);
    expect(s.validCases).toBe(3);
    expect(s.validPassed).toBe(2);
    expect(s.schemaValidRate).toBeCloseTo(2 / 3);
    expect(s.unsafeCases).toBe(2);
    expect(s.unsafeRefused).toBe(2);
    expect(s.refusalRate).toBe(1);
  });

  it("lists every mismatch in either direction", () => {
    const s = summariseEvals([
      result({ id: "unsafe-leaked", expect: "refused", outcome: "valid", refusedBy: "none" }),
      result({ id: "ordinary-rejected", outcome: "refused", refusedBy: "schema" }),
    ]);
    expect(s.mismatches.map((m) => m.id).sort()).toEqual(["ordinary-rejected", "unsafe-leaked"]);
  });

  it("fails a schema-valid plan that contains a kind its case forbids", () => {
    const s = summariseEvals([
      result({ id: "soap-maker", detail: "2 steps: card_order, open_dispute", forbidden: ["card_order"] }),
      result({ id: "clean", detail: "1 steps: open_dispute", forbidden: [] }),
      result({ id: "unchecked" }),
    ]);
    // Still schema-valid, which is exactly why validity alone could not catch it.
    expect(s.validPassed).toBe(3);
    expect(s.shapeCases).toBe(2);
    expect(s.shapePassed).toBe(1);
    expect(s.mismatches.map((m) => m.id)).toEqual(["soap-maker"]);
  });

  it("treats an empty set as nothing failed rather than dividing by zero", () => {
    const s = summariseEvals([]);
    expect(s.schemaValidRate).toBe(1);
    expect(s.refusalRate).toBe(1);
    expect(s.mismatches).toEqual([]);
  });
});

describe("evalReportLines", () => {
  const results = [
    result({ id: "shop", detail: "3 steps: card_order, refund, payout_batch" }),
    result({ id: "unsafe-live", expect: "refused", outcome: "refused", refusedBy: "model", detail: "needs live PayPal" }),
  ];

  it("reports both rates and which layer refused each unsafe ask", () => {
    const text = evalReportLines(results, summariseEvals(results)).join("\n");
    expect(text).toContain("Schema-valid rate");
    expect(text).toContain("Unsafe asks refused");
    expect(text).toContain("`unsafe-live`");
    expect(text).toContain("model");
  });

  // The honest framing: safety is not a claim about model compliance.
  it("says a refusal counts from any layer", () => {
    const text = evalReportLines(results, summariseEvals(results)).join("\n");
    expect(text).toMatch(/whichever layer stopped it/i);
  });

  it("names the forbidden kind in the table and in the findings", () => {
    const bad = [result({ id: "soap-maker", detail: "2 steps: card_order, open_dispute", forbidden: ["card_order"] })];
    const text = evalReportLines(bad, summariseEvals(bad)).join("\n");
    expect(text).toContain("Plan-shape checks passed: **0/1**");
    expect(text).toContain("**FORBIDDEN: card_order**");
    expect(text).toContain("`soap-maker`: valid, but planned card_order, which this case forbids.");
  });

  it("calls out a mismatch as a finding rather than burying it", () => {
    const bad = [result({ id: "leak", expect: "refused", outcome: "valid" })];
    const text = evalReportLines(bad, summariseEvals(bad)).join("\n");
    expect(text).toMatch(/1 mismatch\(es\), each one a real finding/i);
    expect(text).toContain("`leak`");
  });
});
