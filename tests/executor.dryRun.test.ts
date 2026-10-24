import { describe, expect, it } from "vitest";
import type { Scenario } from "../src/core/scenario";
import { dryRunLines } from "../src/executor/dryRun";
import { scenarioWith } from "./helpers/fakePaypal";

const full = (): Scenario => {
  const base = scenarioWith([
    { id: "o1", kind: "card_order", amount: "10.00" },
    { id: "o2", kind: "card_order", amount: "32.50" },
    { id: "r1", kind: "refund", from: "o2", mode: "partial", basisPoints: 2000, needs: ["o2"] },
    { id: "p1", kind: "payout_batch", items: [{ amount: "4.00", unclaimed: true }, { amount: "1.50" }] },
    { id: "i1", kind: "invoice_create", amount: "25.00", dueInDays: -7 },
    { id: "s1", kind: "invoice_send", from: "i1", needs: ["i1"] },
    { id: "d1", kind: "open_dispute" },
  ]);
  return { ...base, webhook: { target: "https://store.test/hook", eventTypes: ["*"] } };
};

const text = (s: Scenario) => dryRunLines(s).join("\n");

describe("dryRunLines", () => {
  it("names the scenario, the business and the currency", () => {
    const out = text(full());
    expect(out).toContain("DRY RUN");
    expect(out).toContain("Test Shop");
    expect(out).toContain("USD");
  });

  it("shows the webhook target, or says plainly that there is none", () => {
    expect(text(full())).toContain("https://store.test/hook");
    const base = scenarioWith([{ id: "o1", kind: "card_order", amount: "1.00" }]);
    expect(text(base)).toMatch(/none declared/i);
  });

  it("groups steps into waves and shows what each one depends on", () => {
    const out = text(full());
    expect(out).toContain("wave 1");
    expect(out).toContain("wave 2");
    expect(out).toContain("after o2");
  });

  it("computes the partial refund figure the run would actually send", () => {
    // 20% of 32.50 is 6.50 exactly.
    expect(text(full())).toContain("partial refund USD 6.50 of 32.50");
  });

  it("totals the money in exact minor units", () => {
    const out = text(full());
    expect(out).toContain("cards charged   USD 42.50");
    expect(out).toContain("invoiced        USD 25.00");
    expect(out).toContain("paid out        USD 5.50");
  });

  it("states how many banked purchases are required", () => {
    expect(text(full())).toMatch(/banked purchases needed: 1/);
    const none = scenarioWith([{ id: "o1", kind: "card_order", amount: "1.00" }]);
    expect(text(none)).toMatch(/banked purchases needed: 0/);
  });

  it("explains that an overdue invoice is produced by a past due date", () => {
    expect(text(full())).toMatch(/due 7 days ago so it reads overdue/);
  });

  it("marks payout items as claimed or unclaimed", () => {
    const out = text(full());
    expect(out).toContain("USD 4.00 unclaimed");
    expect(out).toContain("USD 1.50 claimed");
  });

  it("describes a resend step instead of calling it unknown", () => {
    const out = text(
      scenarioWith([
        { id: "order", kind: "card_order", amount: "25.00" },
        { id: "resend", kind: "resend_webhook", needs: ["order"], from: "order", eventType: "PAYMENT.CAPTURE.COMPLETED" },
      ]),
    );
    expect(out).toContain("ask PayPal to redeliver PAYMENT.CAPTURE.COMPLETED for order");
    expect(out).not.toContain("unknown step");
  });

  // The plan is only reproducible if it is computed, not assumed.
  it("reports an invalid plan instead of printing a confident order", () => {
    const broken = {
      ...scenarioWith([{ id: "o1", kind: "card_order", amount: "1.00" }]),
      steps: [
        { id: "a", kind: "card_order", amount: "1.00", needs: ["b"] },
        { id: "b", kind: "card_order", amount: "1.00", needs: ["a"] },
      ],
    } as unknown as Scenario;
    const out = text(broken);
    expect(out).toContain("PLAN INVALID");
    expect(out).toMatch(/cycle/i);
    expect(out).not.toContain("wave 1");
  });

  // Zero network calls is the point of a dry run.
  it("produces a plan with the network unavailable", () => {
    const original = globalThis.fetch;
    globalThis.fetch = (() => {
      throw new Error("a dry run must not touch the network");
    }) as unknown as typeof fetch;
    try {
      expect(dryRunLines(full()).length).toBeGreaterThan(10);
    } finally {
      globalThis.fetch = original;
    }
  });
});
