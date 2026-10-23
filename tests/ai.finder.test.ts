import { describe, expect, it } from "vitest";
import { classById } from "../src/ai/failureClasses";
import { type FinderDeps, applyTemplate, finderReportLines, runFinder } from "../src/ai/finder";
import type { PlanOutcome } from "../src/ai/planner";
import { DEFAULT_CAPS, checkCaps } from "../src/core/caps";
import { initRunState, recordOutcome } from "../src/core/runState";
import { type Scenario, validateScenario } from "../src/core/scenario";

const ORIGIN = "https://store.test";
const TARGET = `${ORIGIN}/api/paypal/webhook`;
const OPTS = { allowedEventOrigins: [ORIGIN] };

/** A planner reply, put through the real schema so it has the defaults a real one would. */
function planned(over: Record<string, unknown>): Scenario {
  const r = validateScenario(
    { version: 1, name: "Candle Shop", profile: { name: "Candle Shop" }, currency: "USD", ...over },
    OPTS,
  );
  if (!r.ok) throw new Error(r.errors.join("; "));
  return r.scenario;
}

// What the planner actually produced on 2026-10-23: the class's two steps
// padded with an invoice and a payout that could not run.
const padded = () =>
  planned({
    webhook: { target: TARGET },
    steps: [
      { id: "order", kind: "card_order", amount: "150.00" },
      {
        id: "resend-capture",
        kind: "resend_webhook",
        from: "order",
        eventType: "PAYMENT.CAPTURE.COMPLETED",
        needs: ["order"],
      },
      { id: "wholesale-invoice", kind: "invoice_create", amount: "400.00" },
      { id: "pay-suppliers", kind: "payout_batch", items: [{ amount: "50.00" }] },
    ],
  });

const dup = () => classById("duplicate-webhook")!;
const dupTemplate = () => dup().template!;

describe("applyTemplate", () => {
  it("runs only the template's steps, and takes the planner's amount", () => {
    const { candidate, ignored } = applyTemplate(dupTemplate(), padded(), TARGET);
    const steps = candidate["steps"] as Array<Record<string, unknown>>;
    expect(steps.map((s) => [s["id"], s["kind"]])).toEqual([
      ["order", "card_order"],
      ["resend-capture", "resend_webhook"],
    ]);
    expect(steps[0]!["amount"]).toBe("150.00");
    expect(ignored).toEqual([
      "extra step wholesale-invoice (invoice_create)",
      "extra step pay-suppliers (payout_batch)",
    ]);
  });

  it("sets the webhook target itself, whatever the planner wrote", () => {
    const p = {
      ...padded(),
      webhook: { target: TARGET, eventTypes: ["PAYMENT.CAPTURE.COMPLETED"] },
    };
    const other = applyTemplate(dupTemplate(), p, TARGET);
    expect(other.candidate["webhook"]).toEqual({ target: TARGET, eventTypes: ["*"] });

    const noHook = planned({ steps: [{ id: "order", kind: "card_order", amount: "10.00" }] });
    expect(applyTemplate(dupTemplate(), noHook, TARGET).candidate["webhook"]).toEqual({
      target: TARGET,
      eventTypes: ["*"],
    });
  });

  it("leaves the webhook out for a class that does not need one", () => {
    const tpl = classById("refund-after-partial")!.template!;
    const { candidate, ignored } = applyTemplate(tpl, padded(), TARGET);
    expect(candidate).not.toHaveProperty("webhook");
    expect(ignored).toContain("the planner's webhook block");
  });

  it("keeps the template's structure when the planner changes it", () => {
    const p = planned({
      webhook: { target: TARGET },
      steps: [
        { id: "first", kind: "card_order", amount: "5.00" },
        { id: "order", kind: "card_order", amount: "30.00", needs: ["first"] },
        {
          id: "resend-capture",
          kind: "resend_webhook",
          from: "first",
          eventType: "PAYMENT.CAPTURE.REFUNDED",
          needs: ["first"],
        },
      ],
    });
    const { candidate, ignored } = applyTemplate(dupTemplate(), p, TARGET);
    const steps = candidate["steps"] as Array<Record<string, unknown>>;
    expect(steps[0]).toEqual({ id: "order", kind: "card_order", needs: [], amount: "30.00" });
    expect(steps[1]).toEqual({
      id: "resend-capture",
      kind: "resend_webhook",
      needs: ["order"],
      from: "order",
      eventType: "PAYMENT.CAPTURE.COMPLETED",
    });
    expect(ignored).toEqual(
      expect.arrayContaining([
        "extra step first (card_order)",
        "order.needs",
        "resend-capture.from",
        "resend-capture.eventType",
        "resend-capture.needs",
      ]),
    );
  });

  it("keeps the template step when the planner gives the id a different kind", () => {
    const p = planned({
      steps: [{ id: "order", kind: "invoice_create", amount: "99.00" }],
    });
    const { candidate, ignored } = applyTemplate(dupTemplate(), p, TARGET);
    expect((candidate["steps"] as Array<Record<string, unknown>>)[0]).toEqual({
      id: "order",
      kind: "card_order",
      needs: [],
      amount: "25.00",
    });
    expect(ignored).toContain("step order planned as invoice_create, template is card_order");
  });

  it("cannot grow a payout batch through a fillable path", () => {
    const tpl = classById("unclaimed-payout")!.template!;
    const p = planned({
      steps: [
        {
          id: "payout",
          kind: "payout_batch",
          items: [
            { amount: "7.00", unclaimed: false },
            { amount: "400.00" },
            { amount: "400.00" },
          ],
        },
      ],
    });
    const { candidate, ignored } = applyTemplate(tpl, p, null);
    const items = (candidate["steps"] as Array<Record<string, unknown>>)[0]!["items"];
    // The amount is a value and is taken; unclaimed is structure and is not.
    expect(items).toEqual([{ amount: "7.00", unclaimed: true }]);
    expect(ignored).toContain("payout.items");
  });

  it("does not share state between calls", () => {
    applyTemplate(dupTemplate(), padded(), TARGET);
    const order = dupTemplate().steps[0] as { amount: string };
    expect(order.amount).toBe("25.00");
  });
});

describe("every supported class has a minimal template that runs as is", () => {
  const supported = () =>
    ["duplicate-webhook", "refund-after-partial", "unclaimed-payout", "overdue-invoice"].map(
      (id) => classById(id)!,
    );

  it("duplicate-webhook is exactly one card order and one resend", () => {
    expect(dupTemplate().steps.map((s) => s.kind)).toEqual(["card_order", "resend_webhook"]);
    expect(dupTemplate().needsWebhook).toBe(true);
  });

  it("each template passes the schema and the default caps once filled with its own defaults", () => {
    for (const cls of supported()) {
      const tpl = cls.template!;
      const base = planned({ steps: [{ id: "x", kind: "card_order", amount: "1.00" }] });
      const { candidate } = applyTemplate(tpl, base, tpl.needsWebhook ? TARGET : null);
      const r = validateScenario(candidate, OPTS);
      expect(r.ok, `${cls.id}: ${r.ok ? "" : r.errors.join("; ")}`).toBe(true);
      if (r.ok) expect(checkCaps(r.scenario, DEFAULT_CAPS), cls.id).toEqual([]);
    }
  });

  it("each ask is derived from its template, and tells the planner not to add steps", () => {
    for (const cls of supported()) {
      expect(cls.ask, cls.id).toContain(JSON.stringify(cls.template!.steps));
      expect(cls.ask, cls.id).toMatch(/no other steps/);
      expect(cls.ask, cls.id).toMatch(/Do not include a webhook block/);
    }
  });

  it("the unsupported class has no template", () => {
    expect(classById("dispute-on-refunded-order")!.template).toBeNull();
  });
});

describe("runFinder with templates", () => {
  function harness(
    plan: PlanOutcome,
    opts: { validate?: FinderDeps["validate"] } = {},
  ) {
    const ran: Scenario[] = [];
    const modes: string[] = [];
    const planCalls: string[] = [];
    const logs: string[] = [];
    const deps: FinderDeps = {
      plan: async (cls) => {
        planCalls.push(cls.id);
        return plan;
      },
      validate:
        opts.validate ??
        ((c) => {
          const r = validateScenario(c, OPTS);
          return r.ok ? { ok: true, scenario: r.scenario } : { ok: false, errors: r.errors };
        }),
      run: async (scenario, opts) => {
        ran.push(scenario);
        modes.push(opts.webhookMode);
        let s = initRunState({
          runId: "run-x",
          scenarioName: scenario.name,
          currency: "USD",
          steps: scenario.steps.map((st) => ({ id: st.id, kind: st.kind })),
          order: scenario.steps.map((st) => st.id),
          nowIso: "2026-10-23T12:00:00.000Z",
        });
        for (const st of scenario.steps) {
          s = recordOutcome(s, st.id, { kind: "success", detail: "ok" }, "2026-10-23T12:00:01.000Z");
        }
        return s;
      },
      readStore: async () => ({
        orders: [
          { captureId: "CAP-1", fulfilmentCount: 2, refundCount: 0, disputeCount: 0, duplicatesIgnored: 0 },
        ],
        eventCount: 2,
        unverifiedCount: 0,
      }),
      bankAvailable: () => 0,
      log: (l) => logs.push(l),
      now: () => new Date("2026-10-23T12:00:00.000Z"),
    };
    return { deps, ran, modes, planCalls, logs };
  }

  const okPlan = (): PlanOutcome => ({ ok: true, scenario: padded(), raw: "{}" });

  it("runs the two template steps, not the padded plan, and reports what it ignored", async () => {
    const h = harness(okPlan());
    const results = await runFinder(
      { description: "a shop", only: "duplicate-webhook", webhookTarget: TARGET },
      h.deps,
    );
    expect(h.ran).toHaveLength(1);
    expect(h.ran[0]!.steps.map((s) => s.kind)).toEqual(["card_order", "resend_webhook"]);
    expect(h.ran[0]!.webhook).toEqual({ target: TARGET, eventTypes: ["*"] });
    expect(h.modes).toEqual(["reuse-only"]);
    expect(results[0]!.finding.verdict).toBe("bug");
    expect(results[0]!.ignored).toHaveLength(2);
    expect(h.logs.join("\n")).toContain("ignored from the plan: extra step pay-suppliers (payout_batch)");
    expect(finderReportLines(results).join("\n")).toContain(
      "- Ignored from the plan: extra step wholesale-invoice (invoice_create); extra step pay-suppliers (payout_batch)",
    );
  });

  it("does not run, and calls no model, when a webhook class has no target", async () => {
    const h = harness(okPlan());
    const results = await runFinder(
      { description: "a shop", only: "duplicate-webhook", webhookTarget: null },
      h.deps,
    );
    expect(h.planCalls).toEqual([]);
    expect(h.ran).toEqual([]);
    expect(results[0]!.finding.verdict).toBe("inconclusive");
  });

  it("does not run a filled template that fails validation", async () => {
    const h = harness(okPlan(), { validate: () => ({ ok: false, errors: ["over the caps"] }) });
    const results = await runFinder(
      { description: "a shop", only: "duplicate-webhook", webhookTarget: TARGET },
      h.deps,
    );
    expect(h.ran).toEqual([]);
    expect(results[0]!.finding.verdict).toBe("inconclusive");
    expect(results[0]!.finding.likelyFix).toContain("over the caps");
  });
});
