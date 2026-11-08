import { describe, expect, it } from "vitest";
import type { Scenario } from "../lib/engine";
import { planView } from "../lib/planView";
import { PLANS } from "../lib/replays";

/** The dry run as a person reads it (brief v0.7.3 section E): numbered steps with amounts, then totals. */
describe("planView", () => {
  it("reads the Tiny Bakery plan as a numbered list with amounts, then the money totals", () => {
    const v = planView(PLANS[0]!.scenario as unknown as Scenario);
    expect(v.steps.map((s) => `${s.n}. ${s.title}${s.amount === null ? "" : `, ${s.amount}`}`)).toEqual([
      "1. Capture a card payment, USD 45",
      "2. Capture a card payment, USD 60",
      "3. Create an invoice, USD 120",
      "4. Send the invoice",
      "5. Record the invoice payment, USD 120",
    ]);
    expect(v.steps[3]!.note).toBe("Send catering invoice; the invoice from step 3; no email goes to anyone");
    expect(v.totals).toEqual([
      { label: "Cards charged", amount: "USD 105" },
      { label: "Invoiced", amount: "USD 120" },
      { label: "Paid out", amount: "USD 0" },
    ]);
  });

  it("computes a partial refund's amount from its payment, in integer cents", () => {
    const v = planView({
      version: 1,
      name: "x",
      profile: { name: "Shop", country: "US" },
      currency: "USD",
      steps: [
        { id: "o", kind: "card_order", needs: [], amount: "40.00" },
        { id: "r", kind: "refund", needs: ["o"], from: "o", mode: "partial", basisPoints: 2500 },
      ],
    } as unknown as Scenario);
    expect(v.steps[1]).toMatchObject({ title: "Send a partial refund (25%)", amount: "USD 10", note: "of the payment in step 1" });
  });

  it("never shows a raw step kind or the engine's waves", () => {
    const v = planView(PLANS[0]!.scenario as unknown as Scenario);
    const shown = JSON.stringify(v);
    expect(shown).not.toMatch(/card_order|invoice_create|invoice_send|invoice_record_payment|wave/);
  });
});
