import type { PaypalClient } from "../adapters/paypal";
import { seedOf } from "../core/idempotency";
import { pick } from "../core/json";
import { topologicalOrder } from "../core/plan";
import {
  type RunState,
  haltRun,
  initRunState,
  markStarted,
  nextRunnableStep,
  recordMeta,
  recordOutcome,
} from "../core/runState";
import type { Scenario, Step } from "../core/scenario";
import { handlers as defaultHandlers } from "./handlers";
import type { ClaimResult, HandlerRegistry, StepContext, StepOutputs } from "./types";

/**
 * Runs a validated scenario in dependency order.
 *
 * Three invariants: every write carries an idempotency seed derived from the run
 * id and the step id; the run state is persisted after every step so a run can
 * resume; and anything other than success halts the run, because a step we
 * cannot classify may already have moved money.
 */

export type ExecutorDeps = {
  readonly seller: PaypalClient;
  readonly buyer: PaypalClient;
  /** Draws a banked purchase for a dispute step. */
  readonly claimPurchase: (runId: string) => ClaimResult;
  /** Called after every state change, so an interrupted run is resumable. */
  readonly persist: (state: RunState) => void;
  readonly now: () => Date;
  readonly sleep: (ms: number) => Promise<void>;
  readonly log: (line: string) => void;
  readonly env?: Record<string, string | undefined>;
  readonly handlers?: HandlerRegistry;
};

export async function executeScenario(
  args: { scenario: Scenario; runId: string; resume?: RunState | null },
  deps: ExecutorDeps,
): Promise<RunState> {
  const { scenario, runId } = args;
  const registry = deps.handlers ?? defaultHandlers;
  const iso = () => deps.now().toISOString();

  const plan = topologicalOrder(scenario.steps.map((s) => ({ id: s.id, needs: s.needs })));
  if (!plan.ok) {
    // The schema already rejects these, so reaching here is a programming error
    // rather than a scenario problem.
    throw new Error(`scenario plan is invalid: ${plan.errors.map((e) => e.message).join("; ")}`);
  }

  const byId = new Map<string, Step>(scenario.steps.map((s) => [s.id, s]));
  const needsById = new Map<string, readonly string[]>(scenario.steps.map((s) => [s.id, s.needs]));

  let state: RunState;
  if (args.resume !== undefined && args.resume !== null) {
    const sameSteps =
      args.resume.order.length === plan.order.length &&
      args.resume.order.every((id) => byId.has(id)) &&
      plan.order.every((id) => args.resume!.steps[id] !== undefined);
    if (!sameSteps) {
      // Resuming onto a different scenario could re-run or skip money movements.
      throw new Error(
        `run ${args.resume.runId} does not match this scenario's steps, so it cannot be resumed`,
      );
    }
    state = args.resume;
    deps.log(`resuming run ${state.runId} from ${state.updatedAt}`);
  } else {
    state = initRunState({
      runId,
      scenarioName: scenario.name,
      currency: scenario.currency,
      steps: scenario.steps.map((s) => ({ id: s.id, kind: s.kind })),
      order: plan.order,
      nowIso: iso(),
    });
    deps.persist(state);
  }

  if (scenario.webhook !== undefined && state.meta["webhook_id"] === undefined && !state.halted) {
    state = await registerWebhook(scenario, deps, state, iso);
    deps.persist(state);
  }

  for (;;) {
    const stepId = nextRunnableStep(state, needsById);
    if (stepId === null) break;

    const step = byId.get(stepId);
    if (step === undefined) {
      state = haltRun(state, `step ${stepId} vanished from the scenario`, iso());
      deps.persist(state);
      break;
    }

    const handler = registry[step.kind];
    if (handler === undefined) {
      state = recordOutcome(
        state,
        stepId,
        { kind: "unknown", detail: `no handler is registered for step kind ${step.kind}` },
        iso(),
      );
      deps.persist(state);
      break;
    }

    state = markStarted(state, stepId, iso());
    deps.persist(state);
    deps.log(`step ${stepId} (${step.kind}) starting`);

    const outputs = new Map<string, StepOutputs>();
    for (const rec of Object.values(state.steps)) {
      if (rec.status === "succeeded") outputs.set(rec.id, rec.ids);
    }

    // Run id plus step id: a retry of the same step reuses the key, and two
    // different steps can never collide.
    const seedParts = ["run", runId, "step", stepId];

    const ctx: StepContext = {
      runId,
      scenario,
      step,
      seed: seedOf(seedParts),
      seedFor: (...suffix: string[]) => seedOf([...seedParts, ...suffix]),
      meta: state.meta,
      seller: deps.seller,
      buyer: deps.buyer,
      outputs,
      claimPurchase: () => deps.claimPurchase(runId),
      env: deps.env ?? {},
      now: deps.now,
      sleep: deps.sleep,
      log: (line) => deps.log(`  ${line}`),
    };

    let outcome;
    try {
      outcome = await handler(ctx);
    } catch (e) {
      // An exception mid-write tells us nothing about whether it landed.
      outcome = {
        kind: "unknown" as const,
        detail: `handler threw: ${(e as Error).name}: ${(e as Error).message}`,
      };
    }

    state = recordOutcome(state, stepId, outcome, iso());
    deps.persist(state);
    deps.log(`step ${stepId} ${outcome.kind}: ${outcome.detail}`);

    if (state.halted) {
      deps.log(`run halted: ${state.haltReason ?? "no reason recorded"}`);
      break;
    }
  }

  return state;
}

async function registerWebhook(
  scenario: Scenario,
  deps: ExecutorDeps,
  current: RunState,
  iso: () => string,
): Promise<RunState> {
  const webhook = scenario.webhook!;
  const created = await deps.seller.call({
    method: "POST",
    path: "/v1/notifications/webhooks",
    idempotencySeed: seedOf(["webhook", webhook.target]),
    body: { url: webhook.target, event_types: webhook.eventTypes.map((name) => ({ name })) },
  });

  let id = pick(created.body, ["id"]);
  if (id === null) {
    // PayPal refuses a duplicate URL, so an existing registration is reused.
    const list = await deps.seller.call({ method: "GET", path: "/v1/notifications/webhooks" });
    const holder = list.body as { webhooks?: unknown };
    const existing = Array.isArray(holder.webhooks) ? holder.webhooks : [];
    for (const w of existing) {
      if (typeof w === "object" && w !== null) {
        const rec = w as Record<string, unknown>;
        if (rec["url"] === webhook.target && typeof rec["id"] === "string") {
          id = rec["id"];
          break;
        }
      }
    }
    if (id !== null) deps.log(`reusing webhook already registered for ${webhook.target}`);
  }

  if (id === null) {
    // The scenario asked for real events. Running without them would produce a
    // silently incomplete rehearsal.
    return haltRun(
      current,
      `could not register or find a webhook for ${webhook.target}, so the scenario's events would go nowhere`,
      iso(),
    );
  }

  deps.log(`webhook ${id} registered for ${webhook.target}`);
  return recordMeta(current, "webhook_id", id, iso());
}
