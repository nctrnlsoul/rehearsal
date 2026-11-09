import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import plans from "../fixtures/plans.json";
import { defaultHandlers } from "../lib/engine";
import {
  CALL_WORST_S,
  DEFAULT_STEP_WORST_CASE_S,
  DELIVERY_WAIT_S,
  DISPUTE_DELIVERY_WAIT_S,
  HOSTED_CAPS,
  HOSTED_CLIENT,
  HOSTED_MODEL_LIMITS,
  HOSTED_RUN_LIMITS,
  MAX_DURATION_S,
  STEP_WORST_CASE_S,
  TIME_BUDGET_S,
  TOKEN_WORST_S,
  deliveryWaitS,
  hostedConfig,
  hostedGate,
  liveRunsEnabled,
  timeBudgetS,
} from "../lib/hosted";

const STORE = "https://rehearsal-store.vercel.app";
const ENV = { REHEARSAL_STORE_ORIGIN: STORE };

const config = () => {
  const c = hostedConfig(ENV);
  if (!c.ok) throw new Error(c.error);
  return c.config;
};

const scenario = (steps: unknown[], extra: Record<string, unknown> = {}) => ({
  version: 1,
  name: "hosted test",
  profile: { name: "Test Shop" },
  currency: "USD",
  steps,
  ...extra,
});

describe("hosted numbers (R-039, R-049)", () => {
  it("are the ruled ones", () => {
    expect(HOSTED_CAPS).toEqual({ currency: "USD", maxStepAmountMinor: 15_000n, maxTotalMinor: 40_000n, maxSteps: 8, maxDisputes: 1 });
    // R-049: no per-address quota below the global one, so judges on one
    // network each get a session's share.
    expect(HOSTED_RUN_LIMITS).toEqual({ global: 20, session: 5, ip: 20 });
    expect(HOSTED_MODEL_LIMITS).toEqual({ global: 30, session: 8, ip: 30 });
    expect(TIME_BUDGET_S).toBe(600);
  });

  it("put maxDuration = 800 on the run route, never more (R-030)", () => {
    expect(MAX_DURATION_S).toBe(800);
  });
});

// R-054: dispute webhooks arrived 3m04s and 3m21s after filing, after the 90 s wait had ended.
describe("the delivery wait (R-054)", () => {
  it("is 270 s for a plan with a dispute and 90 s for every other plan", () => {
    expect(DELIVERY_WAIT_S).toBe(90);
    expect(DISPUTE_DELIVERY_WAIT_S).toBe(270);
    expect(deliveryWaitS(["open_dispute"])).toBe(270);
    expect(deliveryWaitS(["card_order", "refund", "open_dispute"])).toBe(270);
    for (const kind of Object.keys(STEP_WORST_CASE_S).filter((k) => k !== "open_dispute")) expect(deliveryWaitS([kind]), kind).toBe(90);
    expect(deliveryWaitS([])).toBe(90);
  });

  it("is not counted in any plan's dry-run worst case, a dispute plan's included, as before", () => {
    const c = config();
    const card = hostedGate(scenario([{ id: "o1", kind: "card_order", amount: "10.00" }]), c);
    const dispute = hostedGate(scenario([{ id: "d1", kind: "open_dispute" }]), c);
    expect(card.ok && card.budgetS).toBe(STEP_WORST_CASE_S["card_order"]);
    expect(dispute.ok && dispute.budgetS).toBe(STEP_WORST_CASE_S["open_dispute"]);
  });

  it("is one rule, defined once and read by the worker and the page", () => {
    const read = (f: string) => readFileSync(join(__dirname, "..", f), "utf8");
    expect(read("lib/worker.ts")).toMatch(/deliveryWaitS\(args\.scenario\.steps\.map/);
    expect(read("lib/runStory.ts")).toMatch(/deliveryWaitS\(plan\.steps\.map/);
    for (const f of ["lib/hosted.ts", "lib/worker.ts", "lib/runStory.ts", "lib/liveView.ts", "lib/nowPanel.ts", "components/RunView.tsx"]) {
      expect(read(f), f).not.toMatch(/=\s*(90|270);/);
      expect(read(f), f).not.toMatch(/\b(90|270) s (wait|after its last)/);
    }
  });
});

describe("hostedConfig", () => {
  it("takes the code's numbers when nothing is set", () => {
    const c = config();
    expect(c.caps).toEqual(HOSTED_CAPS);
    expect(c.runLimits).toEqual(HOSTED_RUN_LIMITS);
    expect(c.modelLimits).toEqual(HOSTED_MODEL_LIMITS);
    expect(c.storeOrigin).toBe(STORE);
  });

  it("lets env lower every number and raise none", () => {
    const low = hostedConfig({
      ...ENV,
      REHEARSAL_MAX_STEPS: "3",
      REHEARSAL_MAX_STEP_AMOUNT: "10.00",
      REHEARSAL_MAX_RUN_TOTAL: "20.00",
      REHEARSAL_MAX_DISPUTES: "0",
      CONSOLE_MAX_RUNS_PER_DAY: "2",
      CONSOLE_MAX_RUNS_PER_SESSION: "1",
      CONSOLE_MAX_MODEL_CALLS_PER_DAY: "3",
      CONSOLE_MAX_MODEL_CALLS_PER_SESSION: "2",
    });
    expect(low.ok && low.config.caps).toEqual({ currency: "USD", maxStepAmountMinor: 1000n, maxTotalMinor: 2000n, maxSteps: 3, maxDisputes: 0 });
    expect(low.ok && low.config.runLimits).toEqual({ global: 2, session: 1, ip: 2 });
    expect(low.ok && low.config.modelLimits).toEqual({ global: 3, session: 2, ip: 3 });

    const high = hostedConfig({
      ...ENV,
      REHEARSAL_MAX_STEPS: "60",
      REHEARSAL_MAX_STEP_AMOUNT: "500.00",
      REHEARSAL_MAX_RUN_TOTAL: "2000.00",
      REHEARSAL_MAX_DISPUTES: "9",
      CONSOLE_MAX_RUNS_PER_DAY: "1000",
      CONSOLE_MAX_RUNS_PER_SESSION: "1000",
      CONSOLE_MAX_MODEL_CALLS_PER_DAY: "1000",
      CONSOLE_MAX_MODEL_CALLS_PER_SESSION: "1000",
    });
    expect(high.ok && high.config.caps).toEqual(HOSTED_CAPS);
    expect(high.ok && high.config.runLimits).toEqual(HOSTED_RUN_LIMITS);
    expect(high.ok && high.config.modelLimits).toEqual(HOSTED_MODEL_LIMITS);
  });

  it("refuses, naming the variable, when a number is malformed", () => {
    for (const [name, value] of [["CONSOLE_MAX_RUNS_PER_DAY", "1e3"], ["REHEARSAL_MAX_STEPS", "-1"], ["REHEARSAL_MAX_RUN_TOTAL", "lots"]] as const) {
      const c = hostedConfig({ ...ENV, [name]: value });
      expect(c.ok, name).toBe(false);
      expect(!c.ok && c.error).not.toContain(value);
    }
  });

  it("refuses without the store origin, and with any second event origin", () => {
    expect(hostedConfig({}).ok).toBe(false);
    for (const name of ["REHEARSAL_EVENT_ORIGINS", "REHEARSAL_RECEIVER_ORIGIN"]) {
      const c = hostedConfig({ ...ENV, [name]: "https://receiver-lyart.vercel.app" });
      expect(c.ok, name).toBe(false);
      expect(!c.ok && c.error).toContain(name);
      expect(!c.ok && c.error).not.toContain("receiver-lyart");
    }
  });

  it("refuses a store origin that is not plain https", () => {
    expect(hostedConfig({ REHEARSAL_STORE_ORIGIN: "http://rehearsal-store.vercel.app" }).ok).toBe(false);
  });
});

describe("liveRunsEnabled", () => {
  it("is on only for exactly 'on'", () => {
    expect(liveRunsEnabled({ CONSOLE_LIVE_RUNS: "on" })).toBe(true);
    for (const v of [undefined, "", "ON", "true", "1", " on", "on "]) {
      expect(liveRunsEnabled({ CONSOLE_LIVE_RUNS: v }), String(v)).toBe(false);
    }
  });
});

describe("hostedGate", () => {
  // R-043: the per-step cap is USD 150 so the main recorded plan, whose
  // invoice is USD 120.00, runs hosted for judges.
  it("passes both recorded plans: Tiny Bakery in 487 s, the dispute plan in 239 s", () => {
    const c = config();
    const [bakery, dispute] = plans.plans;
    const b = hostedGate(bakery!.scenario, c);
    expect(b.ok, !b.ok ? b.errors.join("; ") : "").toBe(true);
    expect(b.ok && b.budgetS).toBe(487);
    const d = hostedGate(dispute!.scenario, c);
    expect(d.ok && d.budgetS).toBe(239);
  });

  it("refuses Tiny Bakery on its USD 120 step once a setting lowers the step cap to USD 100", () => {
    const low = hostedConfig({ ...ENV, REHEARSAL_MAX_STEP_AMOUNT: "100.00" });
    expect(low.ok).toBe(true);
    if (!low.ok) return;
    const b = hostedGate(plans.plans[0]!.scenario, low.config);
    expect(!b.ok && b.errors.join("; ")).toContain("USD 120.00, over the per-step cap of USD 100.00");
  });

  it("refuses a step over USD 150, a run over USD 400, 9 steps and 2 disputes", () => {
    const c = config();
    const order = (id: string, amount: string) => ({ id, kind: "card_order", amount, needs: [] });
    expect(hostedGate(scenario([order("a", "150.01")]), c).ok).toBe(false);
    expect(hostedGate(scenario([order("a", "150.00")]), c).ok).toBe(true);
    expect(hostedGate(scenario([order("a", "150.00"), order("b", "150.00"), order("c", "100.00")]), c).ok).toBe(true);
    expect(hostedGate(scenario([order("a", "150.00"), order("b", "150.00"), order("c", "100.00"), order("e", "0.01")]), c).ok).toBe(false);
    expect(hostedGate(scenario(Array.from({ length: 9 }, (_, i) => order(`s${i}`, "1.00"))), c).ok).toBe(false);
    const dispute = (id: string) => ({ id, kind: "open_dispute", needs: [] });
    expect(hostedGate(scenario([dispute("d1")]), c).ok).toBe(true);
    expect(hostedGate(scenario([dispute("d1"), dispute("d2")]), c).ok).toBe(false);
  });

  it("refuses a webhook aimed anywhere but the store's exact handler", () => {
    const c = config();
    const hook = (target: string) => ({ webhook: { target, eventTypes: ["PAYMENT.CAPTURE.COMPLETED"] } });
    const steps = [{ id: "a", kind: "card_order", amount: "5.00", needs: [] }];
    expect(hostedGate(scenario(steps, hook(`${STORE}/api/paypal/webhook`)), c).ok).toBe(true);
    expect(hostedGate(scenario(steps, hook("https://receiver-lyart.vercel.app/api/paypal/webhook")), c).ok).toBe(false);
    expect(hostedGate(scenario(steps, hook(STORE)), c).ok).toBe(false);
  });

  it("refuses a plan whose worst case is over 600 s, and says so", () => {
    const c = config();
    // 5 disputes would also break the dispute cap, so lift that one to isolate the time rule.
    const loose = { ...c, caps: { ...c.caps, maxDisputes: 8 } };
    const g = hostedGate(scenario(Array.from({ length: 3 }, (_, i) => ({ id: `d${i}`, kind: "open_dispute", needs: [] }))), loose);
    expect(g.ok).toBe(false);
    expect(!g.ok && g.errors[0]).toContain("717 s");
    expect(timeBudgetS({ steps: [{ kind: "open_dispute" }, { kind: "card_order" }] } as never)).toBe(302);
  });

  // The old bounds (30 s for most steps, 150 s for a resend) were below what
  // the handlers can take, so a step could start that could not finish. A call
  // is 2 attempts of 20 s, 2 s of retry wait and the spacing: 43 s; a token 20 s.
  it("bounds each step kind by what its handler can take, and every kind has a bound", () => {
    expect(CALL_WORST_S).toBe(43);
    expect(TOKEN_WORST_S).toBe(20);
    expect(STEP_WORST_CASE_S).toEqual({
      card_order: 63,
      refund: 106,
      invoice_create: 149,
      invoice_send: 106,
      invoice_record_payment: 106,
      invoice_cancel: 106,
      payout_batch: 201,
      open_dispute: 239,
      resend_webhook: 354,
    });
    expect(Object.keys(STEP_WORST_CASE_S).sort()).toEqual(Object.keys(defaultHandlers).sort());
    // A kind added later and not measured is assumed slow, never fast.
    expect(DEFAULT_STEP_WORST_CASE_S).toBe(Math.max(...Object.values(STEP_WORST_CASE_S)));
  });

  // The bounds hold only for a client built this way: the engine's default
  // client retries 5 times at 30 s each.
  it("are the bounds of the client both hosted routes build", () => {
    expect(HOSTED_CLIENT).toEqual({ minIntervalMs: 250, policy: { maxAttempts: 2, baseDelayMs: 1000, maxDelayMs: 2000 }, requestTimeoutMs: 20_000 });
    for (const name of ["runs", "finder"]) {
      const route = readFileSync(join(__dirname, "..", "app", "api", name, "route.ts"), "utf8");
      expect(route.match(/new PaypalClient\(/g), name).toHaveLength(2);
      expect(route.match(/\.\.\.HOSTED_CLIENT \}\)/g), name).toHaveLength(2);
    }
  });
});

describe("the run route's duration", () => {
  it.each(["runs", "finder"])("is exported as exactly 800 from the %s route file itself (R-030)", (name) => {
    const route = readFileSync(join(__dirname, "..", "app", "api", name, "route.ts"), "utf8");
    expect(route).toMatch(/^export const maxDuration = 800;$/m);
    expect(route.match(/export const maxDuration/g)).toHaveLength(1);
  });
});
