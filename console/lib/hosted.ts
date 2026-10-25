import { type Caps, capsFromEnv, eventOriginsFromEnv, gateScenario, normalizeOrigin, type Scenario } from "./engine";

/**
 * Everything that makes a hosted run smaller than a local one (R-039). The
 * numbers live here, in code. An environment variable may lower any of them
 * and never raise one, and a malformed variable stops live runs rather than
 * being skipped. Pure, so every rule is tested without a server.
 */

type Env = Record<string, string | undefined>;

/** R-039: 8 steps, USD 100 a step, USD 400 a run, 1 dispute. */
export const HOSTED_CAPS: Caps = {
  currency: "USD",
  maxStepAmountMinor: 10_000n,
  maxTotalMinor: 40_000n,
  maxSteps: 8,
  maxDisputes: 1,
};

export type DailyLimits = { readonly global: number; readonly session: number; readonly ip: number };

/** R-039: per IP bucket uses the per-session numbers, so unlocking again gains nothing. */
export const HOSTED_RUN_LIMITS: DailyLimits = { global: 20, session: 5, ip: 5 };
export const HOSTED_MODEL_LIMITS: DailyLimits = { global: 30, session: 8, ip: 8 };

/** The run route's Vercel limit (R-030). Never above 800: that is beta. */
export const MAX_DURATION_S = 800;
/** R-039: a plan whose worst case is longer than this does not run hosted. */
export const TIME_BUDGET_S = 600;
/** Kept free before each step, for the saves and the delivery wait that follow it. */
export const STEP_MARGIN_S = 60;
/** How long the run waits for late deliveries after its last step, as the finder does. */
export const DELIVERY_WAIT_S = 90;
export const DELIVERY_POLL_S = 5;

/**
 * The longest each step kind can take. A dispute polls up to 120 s for its
 * status; a resend retries PayPal's 404 for up to about 80 s before it can be
 * sent, then waits; everything else is a few calls.
 */
export const STEP_WORST_CASE_S: Readonly<Record<string, number>> = {
  open_dispute: 130,
  resend_webhook: 150,
};
export const DEFAULT_STEP_WORST_CASE_S = 30;

export const worstCaseOf = (kind: string): number => STEP_WORST_CASE_S[kind] ?? DEFAULT_STEP_WORST_CASE_S;

export function timeBudgetS(scenario: Scenario): number {
  return scenario.steps.reduce((sum, s) => sum + worstCaseOf(s.kind), 0);
}

export const KILL_SWITCH_VAR = "CONSOLE_LIVE_RUNS";

/** Exactly "on". Anything else, unset included, keeps live runs paused. */
export function liveRunsEnabled(env: Env): boolean {
  return env[KILL_SWITCH_VAR] === "on";
}

export type HostedConfig = {
  readonly caps: Caps;
  /** The sample store's origin: the one place a hosted run may fire events at. */
  readonly storeOrigin: string;
  readonly runLimits: DailyLimits;
  readonly modelLimits: DailyLimits;
};

export type ConfigResult = { readonly ok: true; readonly config: HostedConfig } | { readonly ok: false; readonly error: string };

const minBig = (a: bigint, b: bigint) => (a < b ? a : b);

function lowered(env: Env, name: string, code: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return code;
  // Plain digits only, as the engine's own limits are read.
  if (!/^\d+$/.test(raw.trim())) throw new Error(`${name} must be a plain integer`);
  return Math.min(code, Number(raw.trim()));
}

/** The hosted configuration, or why there is none. Errors name variables, never values. */
export function hostedConfig(env: Env): ConfigResult {
  // A hosted run fires only at the sample store. A second origin in the
  // environment is a mistake to stop on, not one to quietly ignore.
  for (const name of ["REHEARSAL_EVENT_ORIGINS", "REHEARSAL_RECEIVER_ORIGIN"]) {
    const v = env[name];
    if (v !== undefined && v.trim() !== "") {
      return { ok: false, error: `${name} is set on the console; hosted runs fire only at the sample store, so remove it` };
    }
  }
  const parsed = eventOriginsFromEnv(env);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  if (parsed.origins.length !== 1) return { ok: false, error: "REHEARSAL_STORE_ORIGIN is not set, so a hosted run has nowhere it may fire events" };
  const storeOrigin = normalizeOrigin(parsed.origins[0]!);

  let envCaps: Caps;
  try {
    envCaps = capsFromEnv(env);
  } catch {
    return { ok: false, error: "a cap variable (REHEARSAL_MAX_*) is malformed" };
  }
  const caps: Caps = {
    currency: HOSTED_CAPS.currency,
    maxStepAmountMinor: minBig(HOSTED_CAPS.maxStepAmountMinor, envCaps.maxStepAmountMinor),
    maxTotalMinor: minBig(HOSTED_CAPS.maxTotalMinor, envCaps.maxTotalMinor),
    maxSteps: Math.min(HOSTED_CAPS.maxSteps, envCaps.maxSteps),
    maxDisputes: Math.min(HOSTED_CAPS.maxDisputes, envCaps.maxDisputes),
  };

  try {
    const runSession = lowered(env, "CONSOLE_MAX_RUNS_PER_SESSION", HOSTED_RUN_LIMITS.session);
    const modelSession = lowered(env, "CONSOLE_MAX_MODEL_CALLS_PER_SESSION", HOSTED_MODEL_LIMITS.session);
    return {
      ok: true,
      config: {
        caps,
        storeOrigin,
        runLimits: {
          global: lowered(env, "CONSOLE_MAX_RUNS_PER_DAY", HOSTED_RUN_LIMITS.global),
          session: runSession,
          ip: Math.min(HOSTED_RUN_LIMITS.ip, runSession),
        },
        modelLimits: {
          global: lowered(env, "CONSOLE_MAX_MODEL_CALLS_PER_DAY", HOSTED_MODEL_LIMITS.global),
          session: modelSession,
          ip: Math.min(HOSTED_MODEL_LIMITS.ip, modelSession),
        },
      },
    };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export type HostedGate = { readonly ok: true; readonly scenario: Scenario; readonly budgetS: number } | { readonly ok: false; readonly errors: string[] };

/**
 * The gate a hosted plan passes, for the dry run and the run alike (R-023):
 * the engine's schema, allowlist and caps with the hosted numbers, then the
 * time budget, so a plan the dry run accepts is one the run accepts.
 */
export function hostedGate(candidate: unknown, config: HostedConfig): HostedGate {
  const g = gateScenario(candidate, { allowedEventOrigins: [config.storeOrigin], caps: config.caps });
  if (!g.ok) return g;
  const budgetS = timeBudgetS(g.scenario);
  if (budgetS > TIME_BUDGET_S) {
    return {
      ok: false,
      errors: [`this plan could take up to ${budgetS} s, over the hosted limit of ${TIME_BUDGET_S} s; run it from the CLI`],
    };
  }
  return { ok: true, scenario: g.scenario, budgetS };
}
