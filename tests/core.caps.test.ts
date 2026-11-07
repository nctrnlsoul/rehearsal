import { describe, expect, it } from "vitest";
import { DEFAULT_CAPS, capsFromEnv, checkCaps } from "../src/core/caps";
import { scenarioWith } from "./helpers/fakePaypal";

const codes = (s: Parameters<typeof checkCaps>[0], caps = DEFAULT_CAPS) =>
  checkCaps(s, caps).map((v) => v.code);

describe("checkCaps", () => {
  it("passes an ordinary scenario", () => {
    const s = scenarioWith([
      { id: "o1", kind: "card_order", amount: "54.00" },
      { id: "i1", kind: "invoice_create", amount: "240.00" },
      { id: "p1", kind: "payout_batch", items: [{ amount: "18.00", unclaimed: true }] },
    ]);
    expect(checkCaps(s)).toEqual([]);
  });

  it("rejects a single step over the per-step cap", () => {
    const s = scenarioWith([{ id: "o1", kind: "card_order", amount: "500.01" }]);
    const v = checkCaps(s);
    expect(v.map((x) => x.code)).toEqual(["step-amount-too-large"]);
    expect(v[0]!.stepId).toBe("o1");
    expect(v[0]!.message).toContain("500.01");
  });

  it("allows exactly the cap", () => {
    expect(codes(scenarioWith([{ id: "o1", kind: "card_order", amount: "500.00" }]))).toEqual([]);
  });

  it("catches an oversized payout item inside an otherwise small batch", () => {
    const s = scenarioWith([
      {
        id: "p1",
        kind: "payout_batch",
        items: [{ amount: "1.00" }, { amount: "900.00", unclaimed: true }],
      },
    ]);
    const v = checkCaps(s);
    expect(v.some((x) => x.code === "step-amount-too-large")).toBe(true);
    expect(v[0]!.message).toContain("payout batch of 2 items in step p1 is USD 901.00");
  });

  // The cap is per step: two items under it can still move more than it in one step.
  it("counts a payout batch's items together against the per-step cap", () => {
    const s = scenarioWith([
      { id: "p1", kind: "payout_batch", items: [{ amount: "300.00" }, { amount: "300.00", unclaimed: true }] },
    ]);
    const v = checkCaps(s);
    expect(v.map((x) => x.code)).toEqual(["step-amount-too-large"]);
    expect(v[0]!.stepId).toBe("p1");
    expect(v[0]!.message).toBe("payout batch of 2 items in step p1 is USD 600.00, over the per-step cap of USD 500.00");
    // Exactly the cap in total still passes.
    expect(codes(scenarioWith([{ id: "p1", kind: "payout_batch", items: [{ amount: "250.00" }, { amount: "250.00" }] }]))).toEqual([]);
  });

  it("rejects a run whose total exceeds the cap even when each step is fine", () => {
    const s = scenarioWith(
      Array.from({ length: 5 }, (_, i) => ({
        id: `o${i}`,
        kind: "card_order",
        amount: "450.00",
      })),
    );
    // 5 x 450 = 2250, over the 2000 run cap, but each step is under 500.
    expect(codes(s)).toEqual(["run-total-too-large"]);
  });

  it("rejects too many steps", () => {
    const s = scenarioWith(
      Array.from({ length: 31 }, (_, i) => ({ id: `o${i}`, kind: "card_order", amount: "1.00" })),
    );
    expect(codes(s)).toContain("too-many-steps");
  });

  // Refunds return money and disputes move none, so neither counts as spend.
  it("does not count refunds or disputes toward the total", () => {
    const s = scenarioWith([
      { id: "o1", kind: "card_order", amount: "400.00" },
      { id: "r1", kind: "refund", from: "o1", mode: "full", needs: ["o1"] },
      { id: "d1", kind: "open_dispute" },
    ]);
    expect(checkCaps(s)).toEqual([]);
  });

  // Minor units are not comparable across currencies: 50000 JPY is not 50000
  // USD cents. Measuring one against the other is meaningless, not merely wrong.
  it("refuses a scenario in a currency the caps are not set in", () => {
    const s = scenarioWith([{ id: "o1", kind: "card_order", amount: "1000" }], "JPY");
    const v = checkCaps(s);
    expect(v.map((x) => x.code)).toContain("currency-mismatch");
    expect(v[0]!.message).toContain("JPY");
    expect(v[0]!.message).toContain("USD");
  });

  it("does not report amount violations it could not meaningfully check", () => {
    const s = scenarioWith([{ id: "o1", kind: "card_order", amount: "9999999" }], "JPY");
    const codes = checkCaps(s).map((x) => x.code);
    expect(codes).toContain("currency-mismatch");
    expect(codes).not.toContain("step-amount-too-large");
    expect(codes).not.toContain("run-total-too-large");
  });

  // Disputes move no money but each consumes a banked purchase that cost a
  // human approval click, so they are a capped resource.
  it("caps the number of disputes", () => {
    const ok = scenarioWith([
      { id: "d1", kind: "open_dispute" },
      { id: "d2", kind: "open_dispute" },
    ]);
    expect(checkCaps(ok)).toEqual([]);

    const tooMany = scenarioWith(
      Array.from({ length: 3 }, (_, i) => ({ id: `d${i}`, kind: "open_dispute" })),
    );
    const v = checkCaps(tooMany);
    expect(v.map((x) => x.code)).toContain("too-many-disputes");
    expect(v[0]!.message).toMatch(/human approval/i);
  });

  it("reports every violation at once", () => {
    const s = scenarioWith([
      { id: "o1", kind: "card_order", amount: "900.00" },
      { id: "o2", kind: "card_order", amount: "1500.00" },
    ]);
    const v = checkCaps(s);
    expect(v.filter((x) => x.code === "step-amount-too-large")).toHaveLength(2);
    expect(v.some((x) => x.code === "run-total-too-large")).toBe(true);
  });
});

describe("capsFromEnv", () => {
  it("falls back to the defaults when nothing is set", () => {
    expect(capsFromEnv({})).toEqual(DEFAULT_CAPS);
  });

  it("reads overrides as decimal strings", () => {
    const caps = capsFromEnv({
      REHEARSAL_MAX_STEP_AMOUNT: "10.00",
      REHEARSAL_MAX_RUN_TOTAL: "25.00",
      REHEARSAL_MAX_STEPS: "3",
      REHEARSAL_MAX_DISPUTES: "1",
    });
    expect(caps.maxStepAmountMinor).toBe(1000n);
    expect(caps.maxTotalMinor).toBe(2500n);
    expect(caps.maxSteps).toBe(3);
    expect(caps.maxDisputes).toBe(1);
  });

  it("records the currency the caps are denominated in", () => {
    expect(capsFromEnv({}).currency).toBe("USD");
    expect(capsFromEnv({}, "JPY").currency).toBe("JPY");
  });

  // A malformed cap must never silently widen the limit.
  it("throws on a malformed cap rather than ignoring it", () => {
    expect(() => capsFromEnv({ REHEARSAL_MAX_STEP_AMOUNT: "lots" })).toThrow();
    expect(() => capsFromEnv({ REHEARSAL_MAX_STEP_AMOUNT: "10.005" })).toThrow();
    expect(() => capsFromEnv({ REHEARSAL_MAX_STEPS: "0" })).toThrow();
    expect(() => capsFromEnv({ REHEARSAL_MAX_STEPS: "many" })).toThrow();
    expect(() => capsFromEnv({ REHEARSAL_MAX_STEPS: "2.5" })).toThrow();
    // Number() would read this as 1000. A cap must not widen by notation.
    expect(() => capsFromEnv({ REHEARSAL_MAX_STEPS: "1e3" })).toThrow();
  });
});
