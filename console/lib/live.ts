import type { ConsoleDb } from "./db";
import {
  AiBudgetTracker,
  type GenerateFn,
  RUN_ID_PATTERN,
  type Scenario,
  aiBudgetFromEnv,
  cleanModelText,
  dryRunLines,
  newRunId,
  planScenario,
  scenarioDigest,
} from "./engine";
import { SESSION_COOKIE, clientIp, hashedKey, readCookie, sessionSecret, verifiedSessionId } from "./gate";
import { HOSTED_FINDER_CLASSES, type HostedConfig, hostedConfig, hostedGate, liveRunsEnabled } from "./hosted";

export { HOSTED_FINDER_CLASSES };
import { PLANS } from "./replays";

/**
 * The live routes (Stage B), each a function of its dependencies so every
 * branch is tested without a server. Every one checks, in this order, and
 * fails closed at the first refusal: the kill switch (writes only), a valid
 * session, a same-origin JSON body under a byte cap, the hosted config, the
 * database. Bodies are generic; nothing from PayPal, the model or the
 * database is echoed, and nothing an env var holds is ever named by value.
 */

type Env = Record<string, string | undefined>;

export type LiveDeps = {
  readonly env: Env;
  /** Null when the console has no database, which refuses every live route. */
  readonly db: ConsoleDb | null;
  readonly now: () => number;
};

export type PlanDeps = LiveDeps & {
  /** The model. Null when no key is configured, which refuses before any quota is spent. */
  readonly generate: GenerateFn | null;
};

export type RunsDeps = LiveDeps & {
  /** True when PayPal credentials for both apps are present. Checked before any quota is spent. */
  readonly paypalReady: boolean;
  /** Hands the started run to the worker, inside after(). */
  readonly startWorker: (args: { runId: string; scenario: Scenario; digest: string; config: HostedConfig; db: ConsoleDb }) => void;
};

export const PLAN_BODY_MAX_BYTES = 8192;
export const SMALL_BODY_MAX_BYTES = 1024;
export const DESCRIPTION_MAX_CHARS = 2000;
export const EVENTS_PAGE_MAX = 200;

const json = (status: number, body: unknown, extra: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store", ...extra } });

const refuse = (status: number, error: string, extra: Record<string, unknown> = {}) => json(status, { error, ...extra });

const PAUSED = () => refuse(503, "Live runs are paused on this deployment. Recorded runs still play.");
const NOT_READY = () => refuse(503, "Live runs are not available right now. Recorded runs still play.");

type Caller = { readonly sessionHash: string; readonly ipHash: string };

/** The session and address this request counts against, or null for no valid session. */
function caller(req: Request, env: Env, nowMs: number): Caller | null {
  const secret = sessionSecret(env);
  const id = verifiedSessionId(readCookie(req.headers.get("cookie"), SESSION_COOKIE), secret, nowMs);
  if (secret === null || id === null) return null;
  return { sessionHash: hashedKey(secret, "session", id), ipHash: hashedKey(secret, "ip", clientIp(req.headers)) };
}

function sameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  const host = req.headers.get("host");
  try {
    return origin !== null && host !== null && new URL(origin).host === host;
  } catch {
    return false;
  }
}

// A chunked body carries no Content-Length, so the cap is enforced as bytes arrive.
async function readCapped(req: Request, max: number): Promise<string | null> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (!Number.isFinite(declared) || declared > max) return null;
  if (req.body === null) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

type Body = { readonly ok: true; readonly value: Record<string, unknown> } | { readonly ok: false; readonly response: Response };

/** A same-origin JSON object with exactly the allowed keys, under the cap. */
async function readBody(req: Request, maxBytes: number, keys: readonly string[]): Promise<Body> {
  if (!sameOrigin(req)) return { ok: false, response: refuse(403, "That request did not come from this console.") };
  if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
    return { ok: false, response: refuse(415, "Send JSON.") };
  }
  const text = await readCapped(req, maxBytes);
  if (text === null) return { ok: false, response: refuse(413, "That request is too large.") };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, response: refuse(400, "That request is not valid JSON.") };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, response: refuse(400, "That request is not a JSON object.") };
  }
  const extra = Object.keys(parsed).filter((k) => !keys.includes(k));
  if (extra.length > 0) return { ok: false, response: refuse(400, "That request has fields this route does not take.") };
  return { ok: true, value: parsed as Record<string, unknown> };
}

type Setup = { readonly ok: true; readonly who: Caller; readonly config: HostedConfig; readonly db: ConsoleDb } | { readonly ok: false; readonly response: Response };

/** The checks every live route shares, in the order the module comment gives. */
function setup(req: Request, deps: LiveDeps, opts: { write: boolean }): Setup {
  if (opts.write && !liveRunsEnabled(deps.env)) return { ok: false, response: PAUSED() };
  const who = caller(req, deps.env, deps.now());
  if (who === null) return { ok: false, response: refuse(401, "Unlock the gate first.") };
  const c = hostedConfig(deps.env);
  if (!c.ok) {
    // Names variables, never values.
    console.error(`live: not configured: ${c.error}`);
    return { ok: false, response: NOT_READY() };
  }
  if (deps.db === null) return { ok: false, response: NOT_READY() };
  return { ok: true, who, config: c.config, db: deps.db };
}

const QUOTA_COPY: Record<string, string> = {
  runs_global: "Today's live runs for this console are used up. They reset at 00:00 UTC. Recorded runs still play.",
  runs_session: "This session's live runs for today are used up. They reset at 00:00 UTC. Recorded runs still play.",
  runs_ip: "Live runs from this address for today are used up. They reset at 00:00 UTC. Recorded runs still play.",
  model_global: "Today's planner calls for this console are used up. They reset at 00:00 UTC. The recorded plans still run.",
  model_session: "This session's planner calls for today are used up. They reset at 00:00 UTC. The recorded plans still run.",
  model_ip: "Planner calls from this address for today are used up. They reset at 00:00 UTC. The recorded plans still run.",
};

const quotaRefusal = (scope: string) => refuse(429, QUOTA_COPY[scope] ?? "A daily limit is used up.", { limit: scope });

export type LoadedPlan = { readonly scenario: unknown; readonly sha256: string; readonly description: string | null };

/** A recorded plan by its exact id, or a saved one by uuid. Anything else is no plan. */
export async function loadPlan(db: ConsoleDb, source: unknown, planId: unknown): Promise<LoadedPlan | null> {
  if (typeof planId !== "string") return null;
  if (source === "recorded") {
    const p = PLANS.find((x) => x.plan === planId);
    return p === undefined ? null : { scenario: p.scenario, sha256: p.sha256, description: p.description };
  }
  if (source === "planned") {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(planId)) return null;
    const row = (await db.rpc("console_get_plan", { p_id: planId })) as Record<string, unknown> | null;
    if (row === null || typeof row !== "object" || typeof row["sha256"] !== "string") return null;
    return {
      scenario: row["scenario"],
      sha256: row["sha256"],
      description: typeof row["description"] === "string" ? row["description"] : null,
    };
  }
  return null;
}

async function bankCounts(db: ConsoleDb): Promise<{ available: number; used: number }> {
  const rows = await db.rpc("console_bank_counts", {});
  const row = Array.isArray(rows) ? (rows[0] as Record<string, unknown> | undefined) : undefined;
  const available = Number(row?.["available"]);
  const used = Number(row?.["used"]);
  if (!Number.isInteger(available) || !Number.isInteger(used)) throw new Error("bank counts came back unreadable");
  return { available, used };
}

type DryRun = {
  readonly ok: boolean;
  readonly sha256: string | null;
  readonly budgetS: number | null;
  readonly lines: readonly string[];
  readonly errors: readonly string[];
  readonly bank: { readonly needed: number; readonly available: number; readonly short: boolean };
};

/** What a run of this plan would do, by the same gate the run uses (R-023). */
async function dryRunOf(plan: LoadedPlan, config: HostedConfig, db: ConsoleDb): Promise<DryRun & { scenario: Scenario | null }> {
  const g = hostedGate(plan.scenario, config);
  if (!g.ok) {
    return {
      ok: false,
      sha256: null,
      budgetS: null,
      lines: [],
      errors: g.errors.map((e) => cleanModelText(e, 300)).slice(0, 20),
      bank: { needed: 0, available: 0, short: false },
      scenario: null,
    };
  }
  const needed = g.scenario.steps.filter((s) => s.kind === "open_dispute").length;
  const available = needed === 0 ? 0 : (await bankCounts(db)).available;
  return {
    ok: needed <= available,
    sha256: scenarioDigest(g.scenario),
    budgetS: g.budgetS,
    lines: dryRunLines(g.scenario),
    errors: [],
    bank: { needed, available, short: needed > available },
    scenario: g.scenario,
  };
}

const publicDryRun = ({ scenario: _s, ...rest }: DryRun & { scenario: Scenario | null }) => rest;

// ------------------------------------------------------------------ POST /api/plan

export async function handlePlanPost(req: Request, deps: PlanDeps): Promise<Response> {
  const s = setup(req, deps, { write: true });
  if (!s.ok) return s.response;
  const body = await readBody(req, PLAN_BODY_MAX_BYTES, ["description"]);
  if (!body.ok) return body.response;
  const raw = body.value["description"];
  const description = typeof raw === "string" ? raw.trim() : "";
  if (description === "" || Array.from(description).length > DESCRIPTION_MAX_CHARS) {
    return refuse(400, `Describe the business in 1 to ${DESCRIPTION_MAX_CHARS} characters.`);
  }
  // Before the quota, so a console with no model key spends nobody's call.
  if (deps.generate === null) return NOT_READY();

  try {
    const full = (await s.db.rpc("console_take_daily", {
      p_scopes: ["model_global", "model_session", "model_ip"],
      p_keys: ["all", s.who.sessionHash, s.who.ipHash],
      p_limits: [s.config.modelLimits.global, s.config.modelLimits.session, s.config.modelLimits.ip],
    })) as string | null;
    if (full !== null) return quotaRefusal(full);
  } catch {
    return NOT_READY();
  }

  let outcome;
  try {
    const budget = new AiBudgetTracker({ ...aiBudgetFromEnv(deps.env), maxCallsPerRun: 1 });
    outcome = await planScenario(
      { description, allowedEventOrigins: [s.config.storeOrigin], caps: s.config.caps },
      { generate: deps.generate, budget },
    );
  } catch (e) {
    // The quota stays spent: the call was made or attempted.
    console.error(`live: planner failed (${e instanceof Error ? e.name : "error"})`);
    return refuse(502, "The planner did not answer. Try again, or run a recorded plan.");
  }
  if (!outcome.ok) {
    const reasons =
      outcome.reason === "schema-invalid"
        ? outcome.errors
        : outcome.reason === "over-caps"
          ? outcome.violations.map((v) => v.message)
          : [outcome.detail];
    return refuse(422, "The planner's answer did not pass the checks, so nothing was saved.", {
      reason: outcome.reason,
      reasons: reasons.map((r) => cleanModelText(r, 300)).slice(0, 20),
    });
  }

  try {
    const plan: LoadedPlan = { scenario: outcome.scenario, sha256: "", description };
    const dry = await dryRunOf(plan, s.config, s.db);
    if (dry.scenario === null || dry.sha256 === null) {
      return refuse(422, "The plan passed the planner's checks but not the hosted ones, so nothing was saved.", {
        reason: "hosted-limits",
        reasons: dry.errors,
      });
    }
    const id = await s.db.rpc("console_save_plan", {
      p_session_hash: s.who.sessionHash,
      p_description: description,
      p_scenario: dry.scenario,
      p_sha: dry.sha256,
    });
    if (typeof id !== "string") throw new Error("plan id came back unreadable");
    return json(200, { planId: id, scenario: dry.scenario, dryRun: publicDryRun(dry) });
  } catch {
    return NOT_READY();
  }
}

// ------------------------------------------------------------------ POST /api/dry-run

export async function handleDryRunPost(req: Request, deps: LiveDeps): Promise<Response> {
  const s = setup(req, deps, { write: false });
  if (!s.ok) return s.response;
  const body = await readBody(req, SMALL_BODY_MAX_BYTES, ["source", "planId"]);
  if (!body.ok) return body.response;
  try {
    const plan = await loadPlan(s.db, body.value["source"], body.value["planId"]);
    if (plan === null) return refuse(404, "No such plan.");
    return json(200, publicDryRun(await dryRunOf(plan, s.config, s.db)));
  } catch {
    return NOT_READY();
  }
}

// ------------------------------------------------------------------ POST /api/runs

export async function handleRunsPost(req: Request, deps: RunsDeps): Promise<Response> {
  const s = setup(req, deps, { write: true });
  if (!s.ok) return s.response;
  const body = await readBody(req, SMALL_BODY_MAX_BYTES, ["source", "planId", "sha256", "confirm"]);
  if (!body.ok) return body.response;
  const { source, planId, sha256, confirm } = body.value;
  if (confirm !== true) return refuse(400, "Nothing ran: confirm was not true.");
  if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256)) return refuse(400, "Send the plan's sha256 as 64 hex characters.");
  if (!deps.paypalReady) return NOT_READY();

  try {
    const plan = await loadPlan(s.db, source, planId);
    if (plan === null) return refuse(404, "No such plan.");
    const dry = await dryRunOf(plan, s.config, s.db);
    if (dry.scenario === null || dry.sha256 === null) {
      return refuse(422, "This plan does not pass the hosted checks, so it cannot run here.", { reasons: dry.errors });
    }
    // The digest is recomputed from what the server holds. The browser's copy
    // only has to agree with it, and so does the one saved with the plan.
    if (dry.sha256 !== sha256 || dry.sha256 !== plan.sha256) {
      return refuse(409, "That is not the plan this server holds under that id, so nothing ran. Reload the plan and read it again.");
    }
    if (dry.bank.short) {
      return refuse(409, "The purchase bank has no purchase ready for this plan's dispute, so nothing ran.", { bank: dry.bank });
    }

    const runId = newRunId(new Date(deps.now()));
    const started = await s.db.rpc("console_start_run", {
      p_id: runId,
      p_kind: "scenario",
      p_plan_source: source,
      p_plan_id: planId,
      p_sha: dry.sha256,
      p_session_hash: s.who.sessionHash,
      p_ip_hash: s.who.ipHash,
      p_limit_global: s.config.runLimits.global,
      p_limit_session: s.config.runLimits.session,
      p_limit_ip: s.config.runLimits.ip,
    });
    if (started === "busy") {
      const active = await s.db.rpc("console_active_run", {});
      return refuse(409, "Another live run is going. Watch it, then start yours.", {
        activeRunId: typeof active === "string" && RUN_ID_PATTERN.test(active) ? active : null,
      });
    }
    if (typeof started === "string" && started in QUOTA_COPY) return quotaRefusal(started);
    if (started !== "started") throw new Error("start came back unreadable");

    const scenario = dry.scenario;
    const digest = dry.sha256;
    return await handOff(s.db, runId, () => deps.startWorker({ runId, scenario, digest, config: s.config, db: s.db }));
  } catch {
    return NOT_READY();
  }
}

/**
 * Hands a started run to its worker. If that throws, the run never began, so
 * it is canceled and its quota given back (console_cancel_start) rather than
 * left queued, spending a run and holding the one active slot until the reaper.
 */
async function handOff(db: ConsoleDb, runId: string, start: () => void): Promise<Response> {
  try {
    start();
  } catch (e) {
    console.error(`live: run ${runId} could not be handed to its worker (${e instanceof Error ? e.name : "error"})`);
    await db.rpc("console_cancel_start", { p_id: runId }).catch(() => {
      // Left queued, the reaper closes it within 60 s; the quota then stays spent.
    });
    return NOT_READY();
  }
  return json(202, { runId });
}

// ------------------------------------------------------------------ POST /api/finder

export type FinderDeps = LiveDeps & {
  readonly paypalReady: boolean;
  /** The model. Null when no key is configured, which refuses before any quota is spent. */
  readonly generate: GenerateFn | null;
  readonly startFinder: (args: { runId: string; classId: string; config: HostedConfig; db: ConsoleDb; generate: GenerateFn }) => void;
};

/** One finder class per request (R-028). It spends one run and one model call, together or not at all. */
export async function handleFinderPost(req: Request, deps: FinderDeps): Promise<Response> {
  const s = setup(req, deps, { write: true });
  if (!s.ok) return s.response;
  const body = await readBody(req, SMALL_BODY_MAX_BYTES, ["classId", "confirm"]);
  if (!body.ok) return body.response;
  const { classId, confirm } = body.value;
  if (confirm !== true) return refuse(400, "Nothing ran: confirm was not true.");
  if (typeof classId !== "string" || !HOSTED_FINDER_CLASSES.includes(classId)) {
    return refuse(400, "That is not a finder class this console runs.", { classes: HOSTED_FINDER_CLASSES });
  }
  if (deps.generate === null || !deps.paypalReady) return NOT_READY();

  try {
    const runId = newRunId(new Date(deps.now()));
    const started = await s.db.rpc("console_start_run", {
      p_id: runId,
      p_kind: "finder",
      p_plan_source: "finder",
      p_plan_id: classId,
      p_sha: null,
      p_session_hash: s.who.sessionHash,
      p_ip_hash: s.who.ipHash,
      p_limit_global: s.config.runLimits.global,
      p_limit_session: s.config.runLimits.session,
      p_limit_ip: s.config.runLimits.ip,
      p_model_limits: [s.config.modelLimits.global, s.config.modelLimits.session, s.config.modelLimits.ip],
    });
    if (started === "busy") {
      const active = await s.db.rpc("console_active_run", {});
      return refuse(409, "Another live run is going. Watch it, then start yours.", {
        activeRunId: typeof active === "string" && RUN_ID_PATTERN.test(active) ? active : null,
      });
    }
    if (typeof started === "string" && started in QUOTA_COPY) return quotaRefusal(started);
    if (started !== "started") throw new Error("start came back unreadable");
    const generate = deps.generate;
    return await handOff(s.db, runId, () => deps.startFinder({ runId, classId, config: s.config, db: s.db, generate }));
  } catch {
    return NOT_READY();
  }
}

// ------------------------------------------------------------------ GET /api/runs/[runId]

/** Reading a run needs a session but not the kill switch: a run already going stays watchable. */
export async function handleRunGet(req: Request, runId: string, deps: LiveDeps): Promise<Response> {
  const s = setup(req, deps, { write: false });
  if (!s.ok) return s.response;
  if (!RUN_ID_PATTERN.test(runId)) return refuse(404, "No such run.");
  const afterRaw = new URL(req.url).searchParams.get("after") ?? "0";
  if (!/^\d{1,12}$/.test(afterRaw)) return refuse(400, "after must be a whole number.");
  try {
    const out = await s.db.rpc("console_read_run", { p_id: runId, p_after: Number(afterRaw), p_limit: EVENTS_PAGE_MAX });
    if (out === null) return refuse(404, "No such run.");
    return json(200, out);
  } catch {
    return NOT_READY();
  }
}

// ------------------------------------------------------------------ GET /api/bank

/** Counts only. The console shows how many purchases are left, never which. */
export async function handleBankGet(req: Request, deps: LiveDeps): Promise<Response> {
  const s = setup(req, deps, { write: false });
  if (!s.ok) return s.response;
  try {
    return json(200, await bankCounts(s.db));
  } catch {
    return NOT_READY();
  }
}
