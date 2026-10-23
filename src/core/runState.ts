/**
 * Run state: what happened, what is left, and whether the run may continue.
 * Pure, so the resume logic is testable without a filesystem or a network.
 *
 * The fail-closed rule lives here: an unknown outcome halts the run. A step we
 * cannot classify may have moved money, so guessing either way is worse than
 * stopping and reporting.
 */

export type StepStatus = "pending" | "succeeded" | "failed" | "unknown";

export type StepRecord = {
  readonly id: string;
  readonly kind: string;
  readonly status: StepStatus;
  readonly detail: string;
  readonly ids: Record<string, string>;
  readonly attempts: number;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
};

export type RunState = {
  readonly version: 1;
  readonly runId: string;
  readonly scenarioName: string;
  readonly currency: string;
  readonly order: string[];
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly halted: boolean;
  readonly haltReason: string | null;
  /** Run-level ids that belong to no single step, such as a registered webhook. */
  readonly meta: Record<string, string>;
  readonly steps: Record<string, StepRecord>;
};

export type StepOutcome = {
  readonly kind: "success" | "failed" | "unknown";
  readonly detail: string;
  readonly ids?: Record<string, string>;
};

export function initRunState(args: {
  runId: string;
  scenarioName: string;
  currency: string;
  steps: ReadonlyArray<{ id: string; kind: string }>;
  order: readonly string[];
  nowIso: string;
}): RunState {
  const steps: Record<string, StepRecord> = {};
  for (const s of args.steps) {
    steps[s.id] = {
      id: s.id,
      kind: s.kind,
      status: "pending",
      detail: "",
      ids: {},
      attempts: 0,
      startedAt: null,
      finishedAt: null,
    };
  }
  return {
    version: 1,
    runId: args.runId,
    scenarioName: args.scenarioName,
    currency: args.currency,
    order: [...args.order],
    startedAt: args.nowIso,
    updatedAt: args.nowIso,
    halted: false,
    haltReason: null,
    meta: {},
    steps,
  };
}

export function recordMeta(
  state: RunState,
  key: string,
  value: string,
  nowIso: string,
): RunState {
  return { ...state, meta: { ...state.meta, [key]: value }, updatedAt: nowIso };
}

export function markStarted(state: RunState, stepId: string, nowIso: string): RunState {
  const step = state.steps[stepId];
  if (step === undefined) return state;
  return {
    ...state,
    updatedAt: nowIso,
    steps: {
      ...state.steps,
      [stepId]: { ...step, attempts: step.attempts + 1, startedAt: nowIso },
    },
  };
}

export function recordOutcome(
  state: RunState,
  stepId: string,
  outcome: StepOutcome,
  nowIso: string,
): RunState {
  const step = state.steps[stepId];
  if (step === undefined) return state;

  const status: StepStatus =
    outcome.kind === "success" ? "succeeded" : outcome.kind === "failed" ? "failed" : "unknown";

  const next: RunState = {
    ...state,
    updatedAt: nowIso,
    steps: {
      ...state.steps,
      [stepId]: {
        ...step,
        status,
        detail: outcome.detail,
        ids: { ...step.ids, ...(outcome.ids ?? {}) },
        finishedAt: nowIso,
      },
    },
  };

  // Anything other than success stops the run. A failed step's dependents cannot
  // run correctly, and an unknown step's effect is undetermined.
  if (status === "succeeded") return next;

  const why =
    status === "unknown"
      ? `step ${stepId} ended in an unknown state: ${outcome.detail}`
      : `step ${stepId} failed: ${outcome.detail}`;
  return { ...next, halted: true, haltReason: why };
}

export type RetryResult =
  | { readonly ok: true; readonly state: RunState }
  | { readonly ok: false; readonly error: string };

/**
 * Clears one failed or unknown step back to pending and lifts the halt.
 *
 * Deliberately NOT automatic. An unknown step may already have written, so
 * re-running it could double a payment. Only a human who has checked what
 * actually happened can authorise this, which is why it is an explicit call and
 * why a succeeded step can never be reset.
 */
export function retryStep(state: RunState, stepId: string, nowIso: string): RetryResult {
  const step = state.steps[stepId];
  if (step === undefined) {
    return { ok: false, error: `run ${state.runId} has no step ${stepId}` };
  }
  if (step.status === "succeeded") {
    return {
      ok: false,
      error: `step ${stepId} already succeeded; re-running it could duplicate a payment`,
    };
  }
  if (step.status === "pending") {
    return { ok: false, error: `step ${stepId} has not run yet, so there is nothing to retry` };
  }
  return {
    ok: true,
    state: {
      ...state,
      halted: false,
      haltReason: null,
      updatedAt: nowIso,
      steps: {
        ...state.steps,
        [stepId]: { ...step, status: "pending", detail: "", finishedAt: null },
      },
    },
  };
}

export function haltRun(state: RunState, reason: string, nowIso: string): RunState {
  return { ...state, halted: true, haltReason: reason, updatedAt: nowIso };
}

/**
 * The next step that may run: first in plan order, still pending, with every
 * dependency already succeeded. Returns null when the run is halted or done.
 */
export function nextRunnableStep(
  state: RunState,
  needsById: ReadonlyMap<string, readonly string[]>,
): string | null {
  if (state.halted) return null;
  for (const id of state.order) {
    const step = state.steps[id];
    if (step === undefined || step.status !== "pending") continue;
    const needs = needsById.get(id) ?? [];
    if (needs.every((n) => state.steps[n]?.status === "succeeded")) return id;
  }
  return null;
}

export type RunSummary = {
  readonly total: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly unknown: number;
  readonly pending: number;
  readonly complete: boolean;
  readonly ids: Array<{ step: string; label: string; value: string }>;
};

export function summarize(state: RunState): RunSummary {
  const all = Object.values(state.steps);
  const count = (s: StepStatus) => all.filter((r) => r.status === s).length;
  const ids: Array<{ step: string; label: string; value: string }> = [];
  for (const id of state.order) {
    const rec = state.steps[id];
    if (rec === undefined) continue;
    for (const [label, value] of Object.entries(rec.ids)) {
      ids.push({ step: id, label, value });
    }
  }
  const succeeded = count("succeeded");
  return {
    total: all.length,
    succeeded,
    failed: count("failed"),
    unknown: count("unknown"),
    pending: count("pending"),
    complete: succeeded === all.length,
    ids,
  };
}
