import { createHash, randomBytes } from "node:crypto";
import { resolve } from "node:path";
import type { AiBudgetTracker } from "../ai/budget";
import type { FinderDeps } from "../ai/finder";
import { type GenerateFn, planScenario } from "../ai/planner";
import type { PaypalClient } from "../adapters/paypal";
import { JsonStore } from "../adapters/jsonStore";
import { type Caps, checkCaps } from "../core/caps";
import { parseEventAllowlist } from "../core/eventTarget";
import { type Bank, availablePurchases, claimPurchase, emptyBank } from "../core/purchaseBank";
import { type RunState, retryStep } from "../core/runState";
import { type Scenario, validateScenario } from "../core/scenario";
import { type WebhookMode, executeScenario } from "../executor/executor";
import type { ClaimResult } from "../executor/types";

/** JSON with keys sorted at every level, so a scenario saved and re-read hashes the same. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function scenarioDigest(scenario: Scenario): string {
  return createHash("sha256").update(canonicalJson(scenario)).digest("hex");
}

/**
 * Wiring shared by every front end (the CLI and the MCP server). Each one used
 * to hold its own copy of this, and a guard fixed in one copy would stay open
 * in the other. Nothing here prints or exits: callers decide how to report.
 */

type Env = Record<string, string | undefined>;

export type RuntimePaths = {
  readonly bankPath: string;
  readonly runsDir: string;
};

export function pathsUnder(root: string): RuntimePaths {
  return { bankPath: resolve(root, "bank/purchases.json"), runsDir: resolve(root, "runs") };
}

export const EVENT_ORIGIN_VARS = [
  "REHEARSAL_EVENT_ORIGINS",
  "REHEARSAL_RECEIVER_ORIGIN",
  "REHEARSAL_STORE_ORIGIN",
] as const;

/** Origins a scenario may fire real events at. Empty means none are permitted. */
export function eventOriginsFromEnv(
  env: Env,
): { ok: true; origins: string[] } | { ok: false; error: string } {
  return parseEventAllowlist(
    EVENT_ORIGIN_VARS.map((name) => {
      const raw = env[name];
      return { name, value: raw === undefined || raw.trim() === "" ? null : raw };
    }),
  );
}

/**
 * A run id names a file under runs/, so anything that takes one from outside
 * must match this exactly. Without it, "../bank/purchases" reads the bank.
 */
export const RUN_ID_PATTERN = /^\d{14}-[0-9a-f]{6}$/;

export function newRunId(now: Date): string {
  const stamp = now.toISOString().slice(0, 19).replace(/[:T-]/g, "");
  return `${stamp}-${randomBytes(3).toString("hex")}`;
}

export function runStateStore(runsDir: string, runId: string): JsonStore<RunState | null> {
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new Error("run id must look like 20261023231552-60ea96");
  }
  return new JsonStore<RunState | null>(resolve(runsDir, `${runId}.json`), () => null);
}

export const bankStore = (paths: RuntimePaths) => new JsonStore<Bank>(paths.bankPath, emptyBank);

/** Schema, allowlist and caps in one pass: the gate every scenario passes before it may run. */
export function gateScenario(
  candidate: unknown,
  opts: { allowedEventOrigins: readonly string[]; caps: Caps },
): { ok: true; scenario: Scenario } | { ok: false; errors: string[] } {
  const v = validateScenario(candidate, { allowedEventOrigins: opts.allowedEventOrigins });
  if (!v.ok) return v;
  const violations = checkCaps(v.scenario, opts.caps);
  return violations.length === 0 ? v : { ok: false, errors: violations.map((x) => x.message) };
}

export const NEEDS_BANKED_PURCHASE = "needs a banked purchase: run bank:add";

/**
 * Disputes the scenario would open against usable banked purchases. A run that
 * is short of purchases halts at its dispute step after earlier steps have
 * already written, so the shortfall is reported before anything starts.
 */
export function bankShortfall(
  scenario: Scenario,
  bank: Bank,
): { needed: number; available: number; short: boolean } {
  const needed = scenario.steps.filter((s) => s.kind === "open_dispute").length;
  const available = availablePurchases(bank).length;
  return { needed, available, short: needed > available };
}

export type ResumeLoad =
  | { readonly ok: true; readonly state: RunState; readonly retried: string | null }
  | { readonly ok: false; readonly error: string; readonly halted: boolean };

/**
 * Loads a run to resume. A halted run resumes only with a named step to retry,
 * because the step that halted it may already have written to PayPal.
 */
export function loadResume(
  runsDir: string,
  runId: string,
  retryId: string | null,
  nowIso: string,
): ResumeLoad {
  const state = runStateStore(runsDir, runId).read();
  if (state === null) {
    return {
      ok: false,
      error: `no run state found for ${runId}, so there is nothing to resume`,
      halted: false,
    };
  }
  if (retryId !== null) {
    const reset = retryStep(state, retryId, nowIso);
    return reset.ok
      ? { ok: true, state: reset.state, retried: retryId }
      : { ok: false, error: reset.error, halted: false };
  }
  if (state.halted) {
    return {
      ok: false,
      error: `run ${runId} is halted: ${state.haltReason ?? "no reason recorded"}`,
      halted: true,
    };
  }
  return { ok: true, state, retried: null };
}

export type RunDeps = {
  readonly paths: RuntimePaths;
  readonly seller: PaypalClient;
  readonly buyer: PaypalClient;
  readonly now: () => Date;
  readonly sleep: (ms: number) => Promise<void>;
  readonly log: (line: string) => void;
  readonly env: Env;
};

/** Executes a scenario with run state persisted after every step and the bank drawn safely. */
export async function executeWithPersistence(
  args: {
    scenario: Scenario;
    runId: string;
    resume: RunState | null;
    webhookMode?: WebhookMode;
  },
  deps: RunDeps,
): Promise<RunState> {
  const stateStore = runStateStore(deps.paths.runsDir, args.runId);
  const bank = bankStore(deps.paths);
  const claim = (rid: string): ClaimResult => {
    const result = claimPurchase(bank.read(), rid, deps.now().toISOString());
    if (!result.ok) return { ok: false, error: result.error };
    // Written BEFORE the dispute call. A crash between the two burns one banked
    // purchase, which costs a human click; reusing one would double-dispute a
    // transaction, which is worse.
    bank.write(result.value.bank);
    deps.log(
      `purchase ${result.value.claimed.orderId} claimed and marked used, whatever the dispute call returns`,
    );
    return { ok: true, purchase: result.value.claimed };
  };

  return executeScenario(
    {
      scenario: args.scenario,
      runId: args.runId,
      resume: args.resume,
      webhookMode: args.webhookMode ?? "register",
      scenarioDigest: scenarioDigest(args.scenario),
    },
    {
      seller: deps.seller,
      buyer: deps.buyer,
      claimPurchase: claim,
      persist: (s) => stateStore.write(s),
      now: deps.now,
      sleep: deps.sleep,
      log: deps.log,
      env: deps.env,
    },
  );
}

export const STORE_READ_TIMEOUT_MS = 20_000;

/** Reads the sample store's state endpoint. A non-2xx reply throws with the status only. */
export function storeStateReader(opts: {
  origin: string;
  token: string;
  fetchImpl?: typeof fetch;
}): FinderDeps["readStore"] {
  const doFetch = opts.fetchImpl ?? fetch;
  return async (sinceIso) => {
    const url = new URL(`${opts.origin}/api/store/state`);
    url.searchParams.set("since", sinceIso);
    const res = await doFetch(url, {
      headers: { Authorization: `Bearer ${opts.token}` },
      signal: AbortSignal.timeout(STORE_READ_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`store state read returned http ${res.status}`);
    return (await res.json()) as Awaited<ReturnType<FinderDeps["readStore"]>>;
  };
}

export const DEFAULT_FINDER_DESCRIPTION =
  "a small online shop that takes card orders, invoices wholesale buyers, pays suppliers, and occasionally gets a dispute";

/**
 * The finder's dependencies. Planning aims the model at each class with the
 * class's own ask, and every filled template passes the same scenario gate a
 * hand-written scenario does.
 */
export function finderDepsFrom(opts: {
  generate: GenerateFn;
  budget: AiBudgetTracker;
  caps: Caps;
  allowedEventOrigins: readonly string[];
  run: FinderDeps["run"];
  readStore: FinderDeps["readStore"];
  bankAvailable: () => number;
  log: (line: string) => void;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
}): FinderDeps {
  return {
    plan: (cls, description) =>
      planScenario(
        {
          description,
          extraInstruction: cls.ask,
          allowedEventOrigins: opts.allowedEventOrigins,
          caps: opts.caps,
        },
        { generate: opts.generate, budget: opts.budget },
      ),
    validate: (candidate) =>
      gateScenario(candidate, { allowedEventOrigins: opts.allowedEventOrigins, caps: opts.caps }),
    run: opts.run,
    readStore: opts.readStore,
    bankAvailable: opts.bankAvailable,
    log: opts.log,
    now: opts.now,
    sleep: opts.sleep,
  };
}
