import { fromMinor, toMinor } from "./money";
import type { Scenario } from "./scenario";

/**
 * Spend caps on a scenario, enforced AFTER the schema and independently of it.
 *
 * The schema says a scenario is well formed. Caps say it is small enough to run.
 * Both matter when the author is a language model reading an untrusted business
 * description: a prompt injection that survives the schema still cannot move
 * more money than these allow.
 */

export type Caps = {
  /** Largest single amount any one step may move. */
  readonly maxStepAmountMinor: bigint;
  /** Largest total the whole run may move. */
  readonly maxTotalMinor: bigint;
  /** Tighter than the schema's structural limit. */
  readonly maxSteps: number;
};

export const DEFAULT_CAPS: Caps = {
  maxStepAmountMinor: 50_000n, // USD 500.00
  maxTotalMinor: 200_000n, // USD 2000.00
  maxSteps: 30,
};

export type CapViolationCode =
  | "step-amount-too-large"
  | "run-total-too-large"
  | "too-many-steps";

export type CapViolation = {
  readonly code: CapViolationCode;
  readonly message: string;
  readonly stepId: string | null;
};

/** Every amount a step would move, labelled for error messages. */
function amountsOf(scenario: Scenario): Array<{ stepId: string; label: string; minor: bigint }> {
  const out: Array<{ stepId: string; label: string; minor: bigint }> = [];
  const c = scenario.currency;
  for (const step of scenario.steps) {
    switch (step.kind) {
      case "card_order":
        out.push({ stepId: step.id, label: "card order", minor: toMinor(step.amount, c) });
        break;
      case "invoice_create":
        out.push({ stepId: step.id, label: "invoice", minor: toMinor(step.amount, c) });
        break;
      case "invoice_record_payment":
        if (step.amount !== undefined) {
          out.push({ stepId: step.id, label: "invoice payment", minor: toMinor(step.amount, c) });
        }
        break;
      case "payout_batch":
        step.items.forEach((item, i) =>
          out.push({
            stepId: step.id,
            label: `payout item ${i + 1}`,
            minor: toMinor(item.amount, c),
          }),
        );
        break;
      default:
        // Refunds return money and disputes move none, so neither adds spend.
        break;
    }
  }
  return out;
}

export function checkCaps(scenario: Scenario, caps: Caps = DEFAULT_CAPS): CapViolation[] {
  const violations: CapViolation[] = [];
  const c = scenario.currency;

  if (scenario.steps.length > caps.maxSteps) {
    violations.push({
      code: "too-many-steps",
      message: `scenario has ${scenario.steps.length} steps, the cap is ${caps.maxSteps}`,
      stepId: null,
    });
  }

  const amounts = amountsOf(scenario);

  for (const a of amounts) {
    if (a.minor > caps.maxStepAmountMinor) {
      violations.push({
        code: "step-amount-too-large",
        message: `${a.label} in step ${a.stepId} is ${c} ${fromMinor(a.minor, c)}, over the per-step cap of ${c} ${fromMinor(caps.maxStepAmountMinor, c)}`,
        stepId: a.stepId,
      });
    }
  }

  // Counts money the run MOVES OUT: charges, invoices raised, payouts sent.
  const total = amounts.reduce((sum, a) => sum + a.minor, 0n);
  if (total > caps.maxTotalMinor) {
    violations.push({
      code: "run-total-too-large",
      message: `run would move ${c} ${fromMinor(total, c)}, over the per-run cap of ${c} ${fromMinor(caps.maxTotalMinor, c)}`,
      stepId: null,
    });
  }

  return violations;
}

/** Reads caps from the environment, falling back to the defaults. */
export function capsFromEnv(env: Record<string, string | undefined>, currency = "USD"): Caps {
  const read = (name: string, fallback: bigint): bigint => {
    const raw = env[name];
    if (raw === undefined || raw.trim() === "") return fallback;
    // A malformed cap must not silently widen the limit.
    return toMinor(raw.trim(), currency);
  };
  const steps = env["REHEARSAL_MAX_STEPS"];
  let maxSteps = DEFAULT_CAPS.maxSteps;
  if (steps !== undefined && steps.trim() !== "") {
    // Plain digits only, for the same reason amounts reject "1e2".
    if (!/^\d+$/.test(steps.trim())) {
      throw new Error(`REHEARSAL_MAX_STEPS must be a plain positive integer, got ${steps}`);
    }
    maxSteps = Number(steps.trim());
    if (maxSteps < 1) {
      throw new Error(`REHEARSAL_MAX_STEPS must be at least 1, got ${steps}`);
    }
  }
  return {
    maxStepAmountMinor: read("REHEARSAL_MAX_STEP_AMOUNT", DEFAULT_CAPS.maxStepAmountMinor),
    maxTotalMinor: read("REHEARSAL_MAX_RUN_TOTAL", DEFAULT_CAPS.maxTotalMinor),
    maxSteps,
  };
}
