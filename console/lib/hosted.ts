import { type Caps, FAILURE_CLASSES, capsFromEnv, eventOriginsFromEnv, gateScenario, normalizeOrigin, type Scenario } from "./engine";

/**
 * Everything that makes a hosted run smaller than a local one. The
 * numbers live here, in code. An environment variable may lower any of them
 * and never raise one, and a malformed variable stops live runs rather than
 * being skipped. Pure, so every rule is tested without a server.
 */

type Env = Record<string, string | undefined>;

/** USD 150 a step so Tiny Bakery's USD 120 invoice runs; 8 steps, USD 400 a run, 1 dispute. */
export const HOSTED_CAPS: Caps = {
  currency: "USD",
  maxStepAmountMinor: 15_000n,
  maxTotalMinor: 40_000n,
  maxSteps: 8,
  maxDisputes: 1,
};

export type DailyLimits = { readonly global: number; readonly session: number; readonly ip: number };

/**
 * Quotas are per session and global only. Judges behind
 * one corporate exit share an address, so a per-address bucket at the session
 * number gave all of them one judge's share. The address bucket stays in the
 * database call but at the global number, where it can never bind first.
 */
export const HOSTED_RUN_LIMITS: DailyLimits = { global: 20, session: 5, ip: 20 };
export const HOSTED_MODEL_LIMITS: DailyLimits = { global: 30, session: 8, ip: 30 };

/** The run route's Vercel limit. Never above 800: that is beta. */
export const MAX_DURATION_S = 800;
/** A plan whose worst case is longer than this does not run hosted. */
export const TIME_BUDGET_S = 600;
/** Kept free before each step, for the saves and the delivery wait that follow it. */
export const STEP_MARGIN_S = 60;
/** How long the run waits for late deliveries after its last step, as the finder does. */
export const DELIVERY_WAIT_S = 90;
export const DELIVERY_POLL_S = 5;

/**
 * The longest each step kind can take, so no step starts that cannot finish
 * inside the route's time. A PayPal call that answers takes seconds; one that
 * times out takes 30 s and may be retried once with backoff, so every call is
 * counted at 30 s. Polls run to their budget and the last poll can start just
 * before it ends.
 *
 * - card order, refund, invoice send, record payment, cancel: 1 to 2 calls, 60 s
 * - invoice create: 3 calls (number, create, read back), 90 s
 * - payout batch: create, then polls for 90 s, 130 s
 * - dispute: create, then polls for 120 s, 160 s
 * - resend: polls the event list for up to 120 s, then retries PayPal's
 *   not-found answer for up to 120 s more, 270 s
 */
export const STEP_WORST_CASE_S: Readonly<Record<string, number>> = {
  card_order: 60,
  refund: 60,
  invoice_create: 90,
  invoice_send: 60,
  invoice_record_payment: 60,
  invoice_cancel: 60,
  payout_batch: 130,
  open_dispute: 160,
  resend_webhook: 270,
};
/** For a step kind added later and not yet measured: the largest bound above. */
export const DEFAULT_STEP_WORST_CASE_S = 270;

export const worstCaseOf = (kind: string): number => STEP_WORST_CASE_S[kind] ?? DEFAULT_STEP_WORST_CASE_S;

export function timeBudgetS(scenario: Scenario): number {
  return scenario.steps.reduce((sum, s) => sum + worstCaseOf(s.kind), 0);
}

/** Longest business description a hosted plan request may send. */
export const DESCRIPTION_MAX_CHARS = 2000;

/** The engine's own defaults, for the trust panel, which may not import the engine directly. */
export { DEFAULT_AI_BUDGET, DEFAULT_CAPS, PLANNER_TIMEOUT_MS } from "./engine";

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
    const runGlobal = lowered(env, "CONSOLE_MAX_RUNS_PER_DAY", HOSTED_RUN_LIMITS.global);
    const modelGlobal = lowered(env, "CONSOLE_MAX_MODEL_CALLS_PER_DAY", HOSTED_MODEL_LIMITS.global);
    return {
      ok: true,
      config: {
        caps,
        storeOrigin,
        runLimits: {
          global: runGlobal,
          session: lowered(env, "CONSOLE_MAX_RUNS_PER_SESSION", HOSTED_RUN_LIMITS.session),
          ip: runGlobal,
        },
        modelLimits: {
          global: modelGlobal,
          session: lowered(env, "CONSOLE_MAX_MODEL_CALLS_PER_SESSION", HOSTED_MODEL_LIMITS.session),
          ip: modelGlobal,
        },
      },
    };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export type HostedGate = { readonly ok: true; readonly scenario: Scenario; readonly budgetS: number } | { readonly ok: false; readonly errors: string[] };

/**
 * The gate a hosted plan passes, for the dry run and the run alike:
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

/** The finder classes a hosted request may run: supported, with a fixed template, and no bank draw. */
export const HOSTED_FINDER: ReadonlyArray<{ readonly id: string; readonly title: string }> = FAILURE_CLASSES.filter(
  (c) => c.supported && c.template !== null && !c.needsBankedPurchase,
).map((c) => ({ id: c.id, title: c.title }));

export const HOSTED_FINDER_CLASSES: readonly string[] = HOSTED_FINDER.map((c) => c.id);
