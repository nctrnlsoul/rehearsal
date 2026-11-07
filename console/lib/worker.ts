import type { ConsoleDb } from "./db";
import {
  AiBudgetTracker,
  type Caps,
  type ClaimResult,
  DEFAULT_FINDER_DESCRIPTION,
  type GenerateFn,
  type HandlerRegistry,
  type PaypalClient,
  type Purchase,
  type RunState,
  type Scenario,
  type StepHandler,
  type StoreSnapshot,
  aiBudgetFromEnv,
  cleanModelText,
  defaultHandlers,
  executeScenario,
  finderDepsFrom,
  normalizeOrigin,
  runFinder,
  scenarioDigest,
  summarize,
  webhookHandlerUrl,
} from "./engine";
import { MAX_DETAIL_CHARS, type PlanFacts, type RunEvent, type SeenDeliveries, deliveryEvents, planFacts, savedState, stateEvents } from "./events";
import { DELIVERY_POLL_S, DELIVERY_WAIT_S, STEP_MARGIN_S, worstCaseOf } from "./hosted";

/**
 * Runs one hosted scenario inside the run route's after().
 *
 * Every save is awaited before the next step can reach PayPal, and every
 * write is fenced: once the reaper has called this run dead, the next save
 * comes back false and the worker stops before sending anything else. Nothing
 * here retries a step.
 */

export type WorkerDeps = {
  readonly db: ConsoleDb;
  readonly seller: PaypalClient;
  readonly buyer: PaypalClient;
  /** The store's token-gated state endpoint. Null: heartbeats only, no deliveries. */
  readonly readStore: ((sinceIso: string) => Promise<StoreSnapshot>) | null;
  readonly now: () => Date;
  readonly sleep: (ms: number) => Promise<void>;
  readonly log: (line: string) => void;
  readonly env: Record<string, string | undefined>;
  /** Epoch ms by which this invocation must have finished its own writes. */
  readonly deadlineMs: number;
  readonly handlers?: HandlerRegistry;
};

/** The reaper or a lost database call ended this run's right to write. */
export class FencedError extends Error {
  constructor() {
    super("this run is no longer running in the database, so it stops here");
    this.name = "FencedError";
  }
}

/** Kept clear of the deadline for the last writes: the wait's end and the finish. */
const FINISH_MARGIN_MS = 20_000;

/**
 * Every handler, preceded by a time check. A step that might not finish
 * before this invocation is killed is never started: it fails as "not sent",
 * which is true, rather than becoming an unknown that may have moved money.
 */
export function timeGuarded(base: HandlerRegistry, deadlineMs: number, now: () => Date): HandlerRegistry {
  const out: Record<string, StepHandler> = {};
  for (const [kind, handler] of Object.entries(base)) {
    out[kind] = async (ctx) => {
      const leftS = (deadlineMs - now().getTime()) / 1000;
      const needS = worstCaseOf(kind) + STEP_MARGIN_S;
      if (leftS < needS) {
        return {
          kind: "failed",
          detail: `not sent: ${Math.max(0, Math.floor(leftS))} s were left in this server's time, and this step can take ${worstCaseOf(kind)} s`,
        };
      }
      return handler(ctx);
    };
  }
  return out as HandlerRegistry;
}

function purchaseFrom(rows: unknown, runId: string, nowIso: string): ClaimResult {
  const row = Array.isArray(rows) && rows.length === 1 ? (rows[0] as Record<string, unknown>) : null;
  const text = (k: string) => (row !== null && typeof row[k] === "string" && row[k] !== "" ? (row[k] as string) : null);
  if (row === null) return { ok: false, error: "the hosted purchase bank has no purchase ready to dispute" };
  const orderId = text("order_id");
  const captureId = text("capture_id");
  const txn = text("buyer_transaction_id");
  const amount = text("amount");
  const currency = text("currency");
  if (orderId === null || captureId === null || txn === null || amount === null || currency === null) {
    // Marked used in the database, but unreadable here: never guess at a dispute target.
    return { ok: false, error: "the claimed purchase came back unreadable, so no dispute was filed against it" };
  }
  const purchase: Purchase = {
    id: orderId,
    orderId,
    captureId,
    buyerTransactionId: txn,
    amount,
    currency,
    status: "used",
    createdAt: text("created_at") ?? nowIso,
    approvalUrl: null,
    usedByRunId: runId,
    usedAt: nowIso,
  };
  return { ok: true, purchase };
}

/** What a tracked run's body hands back: the final state, and anything it learned to record. */
type WorkResult = { readonly state: RunState | null; readonly events?: readonly RunEvent[] };

/** Runs one scenario through the engine with this run's fenced saves, claims and time guard. */
type Execute = (scenario: Scenario, digest: string) => Promise<RunState>;

/**
 * Everything a hosted run does around its body: marks it running, saves every
 * state change fenced, claims purchases through the database, polls the store
 * and heartbeats beside the body, waits for late deliveries, then finishes.
 */
async function runTracked(
  runId: string,
  deps: WorkerDeps,
  opts: { readonly deliveryWaitS: number },
  body: (execute: Execute) => Promise<WorkResult>,
): Promise<void> {
  const iso = () => deps.now().toISOString();
  const rpcOk = async (name: "console_save_state" | "console_add_events" | "console_heartbeat", params: Record<string, unknown>) =>
    (await deps.db.rpc(name, { p_id: runId, ...params })) === true;

  if ((await deps.db.rpc("console_mark_running", { p_id: runId })) !== true) {
    deps.log(`run ${runId} was not queued any more, so nothing was started`);
    return;
  }
  const startedIso = iso();

  let prev: RunState | null = null;
  let fenced = false;
  // Set once the scenario is known; read by every save after that.
  let sources: ReadonlyMap<string, string> = new Map();
  let plan: PlanFacts | null = null;

  const persist = async (s: RunState) => {
    if (fenced) throw new FencedError();
    if (!(await rpcOk("console_save_state", { p_state: savedState(s), p_events: stateEvents(prev, s, sources, plan) }))) {
      fenced = true;
      throw new FencedError();
    }
    prev = s;
  };

  const claimPurchase = async (rid: string): Promise<ClaimResult> =>
    purchaseFrom(await deps.db.rpc("console_claim_purchase", { p_run_id: rid }), rid, iso());

  const execute: Execute = (scenario, digest) => {
    sources = new Map(scenario.steps.flatMap((st) => ("from" in st && typeof st.from === "string" ? [[st.id, st.from] as const] : [])));
    plan = planFacts(scenario);
    return executeScenario(
      { scenario, runId, resume: null, webhookMode: "reuse-only", scenarioDigest: digest },
      {
        seller: deps.seller,
        buyer: deps.buyer,
        claimPurchase,
        persist,
        now: deps.now,
        sleep: deps.sleep,
        log: deps.log,
        env: deps.env,
        handlers: timeGuarded(deps.handlers ?? defaultHandlers, deps.deadlineMs, deps.now),
      },
    );
  };

  // The delivery poller runs beside the body and heartbeats while it waits,
  // so a dispute step's two-minute poll never looks like a dead server.
  const seen: SeenDeliveries = new Map();
  let bodyDone = false;
  let waitUntilMs = Number.POSITIVE_INFINITY;
  let storeReadFailures = 0;
  const poll = async () => {
    for (;;) {
      if (fenced) return;
      const nowMs = deps.now().getTime();
      if (bodyDone && nowMs >= waitUntilMs) return;
      if (nowMs >= deps.deadlineMs - FINISH_MARGIN_MS) return;
      let events: RunEvent[] = [];
      if (deps.readStore !== null) {
        try {
          events = deliveryEvents(await deps.readStore(startedIso), seen, iso());
        } catch (e) {
          storeReadFailures += 1;
          // Said once, so the timeline shows the store went quiet rather than nothing arriving.
          if (storeReadFailures === 1) events = [{ kind: "note", data: { store_read_failed: e instanceof Error ? e.name : "error" } }];
        }
      }
      try {
        const ok = events.length > 0 ? await rpcOk("console_add_events", { p_events: events }) : await rpcOk("console_heartbeat", {});
        if (!ok) {
          fenced = true;
          return;
        }
      } catch {
        // A missed heartbeat is survivable; the reaper allows 90 s of them.
      }
      await deps.sleep(DELIVERY_POLL_S * 1000);
    }
  };
  const poller = poll();

  let result: WorkResult;
  try {
    result = await body(execute);
  } catch (e) {
    bodyDone = true;
    waitUntilMs = 0;
    await poller;
    if (e instanceof FencedError || fenced) {
      deps.log(`run ${runId} stopped: the database no longer lists it as running`);
      return;
    }
    // The name only: a message can carry a PayPal, model or database body.
    deps.log(`run ${runId} failed: ${e instanceof Error ? e.name : typeof e}`);
    await finishQuietly(deps, runId, "failed", "the run stopped on an internal error; a step it had started may have written to PayPal");
    return;
  }

  bodyDone = true;
  // Nothing PayPal accepted means nothing for it to deliver, so a halted run
  // with no write that may have landed finishes now rather than wait 90 s.
  const wait = opts.deliveryWaitS > 0 && !haltedBeforeAnyWrite(result.state);
  if (wait) {
    waitUntilMs = Math.min(deps.now().getTime() + opts.deliveryWaitS * 1000, deps.deadlineMs - FINISH_MARGIN_MS);
    if (!fenced) {
      await rpcOk("console_add_events", { p_events: [{ kind: "deliveries_wait_started", data: { seconds: opts.deliveryWaitS } }] }).catch(() => false);
    }
  } else {
    waitUntilMs = 0;
  }
  await poller;
  if (fenced) return;
  const closing: RunEvent[] = [...(result.events ?? [])];
  if (wait) {
    closing.push({ kind: "deliveries_wait_ended", data: { events_seen: [...seen.keys()].filter((k) => k.startsWith("event:")).length } });
  }
  if (closing.length > 0) await rpcOk("console_add_events", { p_events: closing }).catch(() => false);

  const state = result.state;
  if (state === null) {
    await finishQuietly(deps, runId, "halted", "nothing ran");
  } else if (state.halted || !summarize(state).complete) {
    await finishQuietly(deps, runId, "halted", state.haltReason ?? "the run ended with steps that did not run");
  } else {
    await finishQuietly(deps, runId, "complete", "");
  }
}

/**
 * True only for a halted run whose every step is still pending or failed. A
 * succeeded step was accepted by PayPal and an unknown one may have been, so
 * either keeps the wait; a failed step is a refusal, which writes nothing.
 */
export function haltedBeforeAnyWrite(state: RunState | null): boolean {
  if (state === null) return true;
  return state.halted && Object.values(state.steps).every((s) => s.status === "pending" || s.status === "failed");
}

export async function runScenarioWorker(args: { runId: string; scenario: Scenario; digest: string }, deps: WorkerDeps): Promise<void> {
  await runTracked(args.runId, deps, { deliveryWaitS: DELIVERY_WAIT_S }, async (execute) => ({
    state: await execute(args.scenario, args.digest),
  }));
}

export type FinderWorkerDeps = WorkerDeps & {
  readonly generate: GenerateFn;
  readonly caps: Caps;
  readonly storeOrigin: string;
};

const MAX_FINDING_CHARS = 300;

/**
 * One finder class, hosted, one class per request. The engine's finder
 * plans the class's fixed template with one model call, runs it reuse-only,
 * and reads the verdict from the store's own records. The finder
 * waits for its own evidence, so there is no second delivery wait here.
 */
export async function runFinderWorker(args: { runId: string; classId: string }, deps: FinderWorkerDeps): Promise<void> {
  const origins = [normalizeOrigin(deps.storeOrigin)];
  await runTracked(args.runId, deps, { deliveryWaitS: 0 }, async (execute) => {
    let last: RunState | null = null;
    const results = await runFinder(
      { description: DEFAULT_FINDER_DESCRIPTION, only: args.classId, webhookTarget: webhookHandlerUrl(origins[0]!) },
      finderDepsFrom({
        generate: deps.generate,
        budget: new AiBudgetTracker({ ...aiBudgetFromEnv(deps.env), maxCallsPerRun: 1 }),
        caps: deps.caps,
        allowedEventOrigins: origins,
        run: async (scenario) => {
          last = await execute(scenario, scenarioDigest(scenario));
          return last;
        },
        readStore:
          deps.readStore ??
          (async () => {
            throw new Error("no store token");
          }),
        // No hosted class draws on the bank. Reporting none keeps any class that
        // would need one skipped, rather than reaching for a purchase it was not given.
        bankAvailable: () => 0,
        log: deps.log,
        now: deps.now,
        sleep: deps.sleep,
      }),
    );
    const r = results[0];
    const finding =
      r === undefined
        ? null
        : {
            class_id: r.classId,
            verdict: r.finding.verdict,
            title: cleanModelText(r.finding.title, MAX_FINDING_CHARS),
            expected: cleanModelText(r.finding.expected, MAX_FINDING_CHARS),
            actual: cleanModelText(r.finding.actual, MAX_FINDING_CHARS),
            likely_fix: cleanModelText(r.finding.likelyFix, MAX_FINDING_CHARS),
            skipped: r.skipped === null ? null : cleanModelText(r.skipped, MAX_FINDING_CHARS),
          };
    return { state: last, events: finding === null ? [] : [{ kind: "note", data: { finding } }] };
  });
}

/** A failed finish is left to the reaper, which will mark the run abandoned. */
async function finishQuietly(deps: WorkerDeps, runId: string, status: "complete" | "halted" | "failed", reason: string): Promise<void> {
  try {
    await deps.db.rpc("console_finish_run", { p_id: runId, p_status: status, p_reason: cleanModelText(reason, MAX_DETAIL_CHARS) });
  } catch (e) {
    deps.log(`run ${runId} could not record its finish (${e instanceof Error ? e.name : "error"}); the reaper will close it`);
  }
}
