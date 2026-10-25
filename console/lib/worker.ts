import type { ConsoleDb } from "./db";
import {
  type ClaimResult,
  type HandlerRegistry,
  type PaypalClient,
  type Purchase,
  type RunState,
  type Scenario,
  type StepHandler,
  type StoreSnapshot,
  defaultHandlers,
  executeScenario,
  summarize,
} from "./engine";
import { type RunEvent, type SeenDeliveries, deliveryEvents, stateEvents } from "./events";
import { DELIVERY_POLL_S, DELIVERY_WAIT_S, STEP_MARGIN_S, worstCaseOf } from "./hosted";

/**
 * Runs one hosted scenario inside the run route's after() (R-028, R-030).
 *
 * Every save is awaited before the next step can reach PayPal, and every
 * write is fenced: once the reaper has called this run dead, the next save
 * comes back false and the worker stops before sending anything else. Nothing
 * here retries a step (R-020).
 */

export type WorkerDeps = {
  readonly db: ConsoleDb;
  readonly seller: PaypalClient;
  readonly buyer: PaypalClient;
  /** The store's token-gated state endpoint (R-040). Null: heartbeats only, no deliveries. */
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

export async function runScenarioWorker(
  args: { runId: string; scenario: Scenario; digest: string },
  deps: WorkerDeps,
): Promise<void> {
  const { runId } = args;
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
  let finished: RunState | null = null;

  const persist = async (s: RunState) => {
    if (fenced) throw new FencedError();
    if (!(await rpcOk("console_save_state", { p_state: s, p_events: stateEvents(prev, s) }))) {
      fenced = true;
      throw new FencedError();
    }
    prev = s;
  };

  const claimPurchase = async (rid: string): Promise<ClaimResult> =>
    purchaseFrom(await deps.db.rpc("console_claim_purchase", { p_run_id: rid }), rid, iso());

  // The delivery poller runs beside the steps and heartbeats while it waits,
  // so a dispute step's two-minute poll never looks like a dead server.
  const seen: SeenDeliveries = new Map();
  let stepsDone = false;
  let waitUntilMs = Number.POSITIVE_INFINITY;
  let storeReadFailures = 0;
  const poll = async () => {
    for (;;) {
      if (fenced) return;
      const nowMs = deps.now().getTime();
      if (stepsDone && nowMs >= waitUntilMs) return;
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

  try {
    finished = await executeScenario(
      { scenario: args.scenario, runId, resume: null, webhookMode: "reuse-only", scenarioDigest: args.digest },
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
  } catch (e) {
    stepsDone = true;
    waitUntilMs = 0;
    await poller;
    if (e instanceof FencedError || fenced) {
      deps.log(`run ${runId} stopped: the database no longer lists it as running`);
      return;
    }
    // The name only: a message can carry a PayPal or database body.
    deps.log(`run ${runId} failed: ${e instanceof Error ? e.name : typeof e}`);
    await finishQuietly(deps, runId, "failed", "the run stopped on an internal error; a step it had started may have written to PayPal");
    return;
  }

  stepsDone = true;
  waitUntilMs = Math.min(deps.now().getTime() + DELIVERY_WAIT_S * 1000, deps.deadlineMs - FINISH_MARGIN_MS);
  if (!fenced) {
    await rpcOk("console_add_events", { p_events: [{ kind: "deliveries_wait_started", data: { seconds: DELIVERY_WAIT_S } }] }).catch(() => false);
  }
  await poller;
  if (fenced) return;
  await rpcOk("console_add_events", {
    p_events: [{ kind: "deliveries_wait_ended", data: { events_seen: [...seen.keys()].filter((k) => k.startsWith("event:")).length } }],
  }).catch(() => false);

  const summary = summarize(finished);
  if (finished.halted || !summary.complete) {
    await finishQuietly(deps, runId, "halted", finished.haltReason ?? "the run ended with steps that did not run");
  } else {
    await finishQuietly(deps, runId, "complete", "");
  }
}

/** A failed finish is left to the reaper, which will mark the run abandoned. */
async function finishQuietly(deps: WorkerDeps, runId: string, status: "complete" | "halted" | "failed", reason: string): Promise<void> {
  try {
    await deps.db.rpc("console_finish_run", { p_id: runId, p_status: status, p_reason: reason });
  } catch (e) {
    deps.log(`run ${runId} could not record its finish (${e instanceof Error ? e.name : "error"}); the reaper will close it`);
  }
}
