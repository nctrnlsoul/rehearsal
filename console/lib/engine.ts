// The engine is imported from the repo root, not copied, so the console runs
// exactly the code the CLI, the MCP server and the engine's tests run. This is
// the only file that reaches into ../../src; everything else imports from here.
export {
  DEFAULT_FINDER_DESCRIPTION,
  RUN_ID_PATTERN,
  eventOriginsFromEnv,
  finderDepsFrom,
  gateScenario,
  newRunId,
  scenarioDigest,
  storeStateReader,
} from "../../src/app/runtime";
export { type Caps, DEFAULT_CAPS, capsFromEnv } from "../../src/core/caps";
export { normalizeOrigin, webhookHandlerUrl } from "../../src/core/eventTarget";
export type { Scenario, Step } from "../../src/core/scenario";
export { type RunState, type StepRecord, summarize } from "../../src/core/runState";
export { type Purchase, exportForHosted, hostedInsertSql } from "../../src/core/purchaseBank";
export { fromMinor, toMinor } from "../../src/core/money";
export { PaypalClient } from "../../src/adapters/paypal";
export { credentialsFor, MissingCredentialError } from "../../src/adapters/env";
export { type ExecutorDeps, SCENARIO_DIGEST_KEY, executeScenario } from "../../src/executor/executor";
export { handlers as defaultHandlers } from "../../src/executor/handlers";
export type { ClaimResult, HandlerRegistry, StepHandler } from "../../src/executor/types";
export { dryRunLines } from "../../src/executor/dryRun";
export { AiBudgetTracker, aiBudgetFromEnv } from "../../src/ai/budget";
export { DEFAULT_PLANNER_MODEL, type GenerateFn, type PlanOutcome, anthropicGenerator, cleanModelText, planScenario } from "../../src/ai/planner";
export { type ClassResult, runFinder } from "../../src/ai/finder";
export { FAILURE_CLASSES, type StoreSnapshot, classById } from "../../src/ai/failureClasses";
