import { describe, expect, it } from "vitest";
import { type StoreSnapshot, classById } from "../src/ai/failureClasses";
import {
  EVIDENCE_POLL_MS,
  EVIDENCE_TIMEOUT_MS,
  type FinderDeps,
  applyTemplate,
  finderReportLines,
  runFinder,
} from "../src/ai/finder";
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

const EV = "WH-RESENT-1";

/** A store reply carrying the resent event's delivery counts. */
const snapshot = (fulfilled: number, duplicatesIgnored = 0): StoreSnapshot => ({
  orders: [],
  deliveries: [{ eventId: EV, fulfilled, duplicatesIgnored, other: 0 }],
  eventCount: fulfilled + duplicatesIgnored,
  unverifiedCount: 0,
});

describe("runFinder with templates", () => {
  function harness(
    plan: PlanOutcome,
    opts: {
      validate?: FinderDeps["validate"];
      /** Store replies in order; the last one repeats. A function throws on that read. */
      store?: Array<StoreSnapshot | (() => never)>;
    } = {},
  ) {
    const ran: Scenario[] = [];
    const modes: string[] = [];
    const planCalls: string[] = [];
    const logs: string[] = [];
    const sleeps: number[] = [];
    const replies = opts.store ?? [snapshot(2)];
    let reads = 0;
    let clock = Date.parse("2026-10-23T12:00:00.000Z");
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
          const ids: Record<string, string> =
            st.kind === "resend_webhook"
              ? { resent_event_id: EV }
              : st.kind === "refund"
                ? { refund_id: `RF-${st.id}` }
                : {};
          s = recordOutcome(s, st.id, { kind: "success", detail: "ok", ids }, "2026-10-23T12:00:01.000Z");
        }
        return s;
      },
      readStore: async () => {
        const next = replies[Math.min(reads, replies.length - 1)]!;
        reads += 1;
        return typeof next === "function" ? next() : next;
      },
      bankAvailable: () => 0,
      log: (l) => logs.push(l),
      now: () => new Date(clock),
      sleep: async (ms) => {
        sleeps.push(ms);
        clock += ms;
      },
    };
    return { deps, ran, modes, planCalls, logs, sleeps, reads: () => reads };
  }

  const okPlan = (): PlanOutcome => ({ ok: true, scenario: padded(), raw: "{}" });
  const findDup = (h: ReturnType<typeof harness>) =>
    runFinder({ description: "a shop", only: "duplicate-webhook", webhookTarget: TARGET }, h.deps);

  it("runs the two template steps, not the padded plan, and reports what it ignored", async () => {
    const h = harness(okPlan());
    const results = await findDup(h);
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

  it("turns a planner call that throws into an inconclusive class, and keeps going", async () => {
    const h = harness(okPlan());
    let calls = 0;
    const throwing = {
      ...h.deps,
      plan: async () => {
        calls += 1;
        const e = new Error("The operation was aborted due to timeout");
        e.name = "TimeoutError";
        throw e;
      },
    };
    const results = await runFinder({ description: "a shop", webhookTarget: TARGET }, throwing);
    expect(calls).toBe(4);
    expect(h.ran).toEqual([]);
    const ran = results.filter((r) => r.skipped === "planner call failed");
    expect(ran).toHaveLength(4);
    for (const r of ran) {
      expect(r.finding.verdict).toBe("inconclusive");
      expect(r.finding.actual).toBe("the planner call failed: TimeoutError: The operation was aborted due to timeout");
    }
  });

  // The planner strips its own output; this proves the sinks do too, whatever reaches them.
  it("strips control characters from every log line and report line", async () => {
    const nasty = "\u001b[2J\u001b]0;pwned\u0007‮";
    const h = harness({ ok: false, reason: "schema-invalid", errors: [`bad ${nasty}`], raw: "" });
    const results = await findDup(h);
    const report = finderReportLines(results);
    expect(h.logs.join("\n")).toContain("[2J ]0;pwned");
    for (const line of [...h.logs, ...report]) expect(line).not.toMatch(/[\p{Cc}\p{Cf}]/u);
  });

  it("does not run a filled template that fails validation", async () => {
    const h = harness(okPlan(), { validate: () => ({ ok: false, errors: ["over the caps"] }) });
    const results = await findDup(h);
    expect(h.ran).toEqual([]);
    expect(results[0]!.finding.verdict).toBe("inconclusive");
    expect(results[0]!.finding.likelyFix).toContain("over the caps");
  });

  // The three outcomes, each reached by evidence rather than by having waited.
  describe("waiting for the redelivery", () => {
    it("is a bug once the second delivery shows up fulfilled", async () => {
      const h = harness(okPlan(), { store: [snapshot(1), snapshot(1), snapshot(2)] });
      const results = await findDup(h);
      expect(results[0]!.finding.verdict).toBe("bug");
      expect(h.reads()).toBe(3);
      expect(h.sleeps).toEqual([EVIDENCE_POLL_MS, EVIDENCE_POLL_MS]);
    });

    it("is ok once the second delivery shows up recognized as a duplicate", async () => {
      const h = harness(okPlan(), { store: [snapshot(1), snapshot(1, 1)] });
      const results = await findDup(h);
      expect(results[0]!.finding.verdict).toBe("ok");
      expect(h.reads()).toBe(2);
    });

    it("is inconclusive, never ok, when only one delivery has arrived by the timeout", async () => {
      const h = harness(okPlan(), { store: [snapshot(1)] });
      const results = await findDup(h);
      expect(results[0]!.finding.verdict).toBe("inconclusive");
      expect(results[0]!.finding.actual).toMatch(/only one delivery/);
      const waited = h.sleeps.reduce((a, b) => a + b, 0);
      expect(waited).toBe(EVIDENCE_TIMEOUT_MS);
      expect(h.logs.join("\n")).toContain("stopped waiting after 90s");
    });

    // Waiting cannot un-cut a window, and a cut window may be missing the rows
    // the verdict counts.
    it("gives no verdict, and does not wait, when the store's window was cut", async () => {
      const h = harness(okPlan(), { store: [{ ...snapshot(1, 1), truncated: true }] });
      const results = await findDup(h);
      expect(results[0]!.finding.verdict).toBe("inconclusive");
      expect(h.sleeps).toEqual([]);
    });

    it("does not wait when the first read already decides", async () => {
      const h = harness(okPlan(), { store: [snapshot(2)] });
      await findDup(h);
      expect(h.sleeps).toEqual([]);
    });

    it("keeps waiting through a failed re-read, and a failure never becomes a pass", async () => {
      const boom = () => {
        throw new Error("store state read returned http 503");
      };
      const h = harness(okPlan(), { store: [snapshot(1), boom, snapshot(2)] });
      const results = await findDup(h);
      expect(results[0]!.finding.verdict).toBe("bug");
      expect(h.logs.join("\n")).toContain("store re-read failed: store state read returned http 503");
    });

    it("turns a failed first read into an inconclusive finding, not a crash", async () => {
      const boom = () => {
        throw new Error("store state read returned http 503");
      };
      const h = harness(okPlan(), { store: [boom] });
      const results = await findDup(h);
      expect(results[0]!.finding.verdict).toBe("inconclusive");
      expect(results[0]!.finding.actual).toContain("store state read returned http 503");
      expect(results[0]!.runId).toBe("run-x");
    });

    it("treats a reply that is not a store state object as a failed read", async () => {
      for (const reply of [null, {}, { orders: "none" }, "ok"]) {
        const h = harness(okPlan(), { store: [reply as never] });
        const results = await findDup(h);
        expect(results[0]!.finding.verdict, JSON.stringify(reply)).toBe("inconclusive");
        expect(results[0]!.finding.actual).toContain("not a store state object");
      }
    });

    it("says the re-reads failed, rather than that nothing arrived, when they all did", async () => {
      const boom = () => {
        throw new Error("timeout");
      };
      const h = harness(okPlan(), { store: [snapshot(0), boom] });
      const results = await findDup(h);
      expect(results[0]!.finding.verdict).toBe("inconclusive");
      expect(results[0]!.finding.actual).toMatch(/\(\d+ store re-read\(s\) failed while waiting\)$/);
    });

    it("stops on the poll bound even if the clock never moves", async () => {
      const h = harness(okPlan(), { store: [snapshot(1)] });
      const frozen = { ...h.deps, sleep: async () => {} };
      const results = await runFinder(
        { description: "a shop", only: "duplicate-webhook", webhookTarget: TARGET },
        frozen,
      );
      expect(results[0]!.finding.verdict).toBe("inconclusive");
      expect(h.reads()).toBeLessThanOrEqual(EVIDENCE_TIMEOUT_MS / EVIDENCE_POLL_MS + 3);
    });
  });

  // refund-after-partial used to read the store once, so a refund event still
  // in flight read as one the store never got.
  describe("waiting for the refund events", () => {
    const refunds = (partial: unknown, second: unknown): StoreSnapshot => ({
      orders: [
        ...(partial === null
          ? []
          : [{ captureId: "RF-refund-partial", fulfilmentCount: 0, refundCount: partial as number, disputeCount: 0, duplicatesIgnored: 0 }]),
        ...(second === null
          ? []
          : [{ captureId: "RF-refund-second", fulfilmentCount: 0, refundCount: second as number, disputeCount: 0, duplicatesIgnored: 0 }]),
      ],
      eventCount: 0,
      unverifiedCount: 0,
    });
    const findRefund = (h: ReturnType<typeof harness>) =>
      runFinder({ description: "a shop", only: "refund-after-partial", webhookTarget: TARGET }, h.deps);

    it("is ok once the second refund event shows up, recorded once", async () => {
      const h = harness(okPlan(), { store: [refunds(1, null), refunds(1, null), refunds(1, 1)] });
      const results = await findRefund(h);
      expect(results[0]!.finding.verdict).toBe("ok");
      expect(h.reads()).toBe(3);
    });

    it("is a bug once a refund event shows up recorded twice", async () => {
      const h = harness(okPlan(), { store: [refunds(1, null), refunds(1, 2)] });
      const results = await findRefund(h);
      expect(results[0]!.finding.verdict).toBe("bug");
    });

    it("is inconclusive, never ok or bug, when a refund event is still missing at the timeout", async () => {
      const h = harness(okPlan(), { store: [refunds(1, null)] });
      const results = await findRefund(h);
      expect(results[0]!.finding.verdict).toBe("inconclusive");
      expect(h.sleeps.reduce((a, b) => a + b, 0)).toBe(EVIDENCE_TIMEOUT_MS);
    });

    it("does not wait on a non-numeric count, and calls it inconclusive", async () => {
      const h = harness(okPlan(), { store: [refunds(1, "1")] });
      const results = await findRefund(h);
      expect(results[0]!.finding.verdict).toBe("inconclusive");
      expect(h.sleeps).toEqual([]);
    });
  });
});
