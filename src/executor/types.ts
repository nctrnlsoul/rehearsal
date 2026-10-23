import type { PaypalClient } from "../adapters/paypal";
import type { Purchase } from "../core/purchaseBank";
import type { StepOutcome } from "../core/runState";
import type { Scenario, Step, StepKind } from "../core/scenario";

/** Ids a step produced, keyed by a stable label such as `capture_id`. */
export type StepOutputs = Readonly<Record<string, string>>;

export type ClaimResult =
  | { readonly ok: true; readonly purchase: Purchase }
  | { readonly ok: false; readonly error: string };

export type StepContext = {
  readonly runId: string;
  readonly scenario: Scenario;
  readonly step: Step;
  /** Idempotency seed for this step: run id plus step id, as the milestone requires. */
  readonly seed: string;
  readonly seller: PaypalClient;
  readonly buyer: PaypalClient;
  /** Ids from steps that already succeeded, keyed by step id. */
  readonly outputs: ReadonlyMap<string, StepOutputs>;
  /** Draws one banked purchase and marks it used. */
  claimPurchase(): ClaimResult;
  readonly env: Readonly<Record<string, string | undefined>>;
  now(): Date;
  sleep(ms: number): Promise<void>;
  log(line: string): void;
};

export type StepHandler = (ctx: StepContext) => Promise<StepOutcome>;
export type HandlerRegistry = Readonly<Record<StepKind, StepHandler>>;

export const succeeded = (detail: string, ids: Record<string, string> = {}): StepOutcome => ({
  kind: "success",
  detail,
  ids,
});

export const failed = (detail: string, ids: Record<string, string> = {}): StepOutcome => ({
  kind: "failed",
  detail,
  ids,
});

export const unknown = (detail: string, ids: Record<string, string> = {}): StepOutcome => ({
  kind: "unknown",
  detail,
  ids,
});

/**
 * A handler receiving the wrong step kind is a wiring bug, not a PayPal
 * condition, and it must not be reported as a payment failure.
 */
export function wrongKind(expected: StepKind, actual: StepKind): StepOutcome {
  return unknown(`handler for ${expected} received a ${actual} step, which is a wiring bug`);
}

export function outputOf(
  ctx: StepContext,
  stepId: string,
  label: string,
): string | null {
  const out = ctx.outputs.get(stepId);
  const value = out?.[label];
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

export function findStep(scenario: Scenario, id: string): Step | undefined {
  return scenario.steps.find((s) => s.id === id);
}
