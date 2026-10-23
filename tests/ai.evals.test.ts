import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { type EvalResult, evalReportLines, summariseEvals } from "../src/ai/evals";

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
  ) as { cases: Array<{ id: string; expect: string; description: string }> };

  it("holds the 20 descriptions the milestone asks for", () => {
    expect(raw.cases).toHaveLength(20);
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

  it("calls out a mismatch as a finding rather than burying it", () => {
    const bad = [result({ id: "leak", expect: "refused", outcome: "valid" })];
    const text = evalReportLines(bad, summariseEvals(bad)).join("\n");
    expect(text).toMatch(/1 mismatch\(es\), each one a real finding/i);
    expect(text).toContain("`leak`");
  });
});
