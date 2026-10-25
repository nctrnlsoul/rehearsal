import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import plans from "../fixtures/plans.json";
import {
  HOSTED_CAPS,
  HOSTED_MODEL_LIMITS,
  HOSTED_RUN_LIMITS,
  MAX_DURATION_S,
  TIME_BUDGET_S,
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

describe("hosted numbers (R-039)", () => {
  it("are the ruled ones", () => {
    expect(HOSTED_CAPS).toEqual({ currency: "USD", maxStepAmountMinor: 10_000n, maxTotalMinor: 40_000n, maxSteps: 8, maxDisputes: 1 });
    expect(HOSTED_RUN_LIMITS).toEqual({ global: 20, session: 5, ip: 5 });
    expect(HOSTED_MODEL_LIMITS).toEqual({ global: 30, session: 8, ip: 8 });
    expect(TIME_BUDGET_S).toBe(600);
  });

  it("put maxDuration = 800 on the run route, never more (R-030)", () => {
    expect(MAX_DURATION_S).toBe(800);
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
    expect(low.ok && low.config.runLimits).toEqual({ global: 2, session: 1, ip: 1 });
    expect(low.ok && low.config.modelLimits).toEqual({ global: 3, session: 2, ip: 2 });

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
  // Found while building: Tiny Bakery's invoice is USD 120.00, over the ruled
  // USD 100 per-step cap, so as recorded it cannot run hosted. Brian decides
  // between raising the cap, a new recorded plan, or marking it CLI-only.
  it("passes the recorded dispute plan and refuses Tiny Bakery on its USD 120 step", () => {
    const c = config();
    const [bakery, dispute] = plans.plans;
    const b = hostedGate(bakery!.scenario, c);
    expect(b.ok).toBe(false);
    expect(!b.ok && b.errors.join("; ")).toContain("USD 120.00, over the per-step cap of USD 100.00");
    const d = hostedGate(dispute!.scenario, c);
    expect(d.ok && d.budgetS).toBe(130);
  });

  it("refuses a step over USD 100, a run over USD 400, 9 steps and 2 disputes", () => {
    const c = config();
    const order = (id: string, amount: string) => ({ id, kind: "card_order", amount, needs: [] });
    expect(hostedGate(scenario([order("a", "100.01")]), c).ok).toBe(false);
    expect(hostedGate(scenario([order("a", "100.00")]), c).ok).toBe(true);
    expect(hostedGate(scenario([order("a", "100.00"), order("b", "100.00"), order("c", "100.00"), order("d", "100.00"), order("e", "0.01")]), c).ok).toBe(false);
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
    const g = hostedGate(scenario(Array.from({ length: 5 }, (_, i) => ({ id: `d${i}`, kind: "open_dispute", needs: [] }))), loose);
    expect(g.ok).toBe(false);
    expect(!g.ok && g.errors[0]).toContain("650 s");
    expect(timeBudgetS({ steps: [{ kind: "open_dispute" }, { kind: "card_order" }] } as never)).toBe(160);
  });
});

describe("the run route's duration", () => {
  it.each(["runs", "finder"])("is exported as exactly 800 from the %s route file itself (R-030)", (name) => {
    const route = readFileSync(join(__dirname, "..", "app", "api", name, "route.ts"), "utf8");
    expect(route).toMatch(/^export const maxDuration = 800;$/m);
    expect(route.match(/export const maxDuration/g)).toHaveLength(1);
  });
});
