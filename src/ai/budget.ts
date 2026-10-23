/**
 * Cost guard for the AI layer.
 *
 * A misconfigured retry loop has burned five figures overnight, so every call
 * caps its output tokens, every run caps its number of calls, and every piece of
 * untrusted input caps its size before it reaches the model. All three fail
 * closed: exceeding any of them throws rather than trimming and continuing.
 */

export type AiBudget = {
  readonly maxCallsPerRun: number;
  readonly maxOutputTokensPerCall: number;
  readonly maxInputChars: number;
};

export const DEFAULT_AI_BUDGET: AiBudget = {
  maxCallsPerRun: 6,
  maxOutputTokensPerCall: 4000,
  maxInputChars: 4000,
};

export type BudgetCode = "calls-exhausted" | "input-too-large";

export class BudgetExceededError extends Error {
  readonly code: BudgetCode;

  constructor(code: BudgetCode, message: string) {
    super(message);
    this.name = "BudgetExceededError";
    this.code = code;
  }
}

export class AiBudgetTracker {
  readonly budget: AiBudget;
  #calls = 0;
  #inputTokens = 0;
  #outputTokens = 0;

  constructor(budget: AiBudget = DEFAULT_AI_BUDGET) {
    this.budget = budget;
  }

  /** Call before sending untrusted text, so an oversized input never reaches the model. */
  assertInputWithinLimit(text: string, label = "input"): void {
    if (text.length > this.budget.maxInputChars) {
      throw new BudgetExceededError(
        "input-too-large",
        `${label} is ${text.length} characters, over the limit of ${this.budget.maxInputChars}`,
      );
    }
  }

  /** Reserves one call. Throws when the run has no calls left. */
  beginCall(): number {
    if (this.#calls >= this.budget.maxCallsPerRun) {
      throw new BudgetExceededError(
        "calls-exhausted",
        `this run has already made its ${this.budget.maxCallsPerRun} permitted model calls`,
      );
    }
    this.#calls += 1;
    return this.#calls;
  }

  recordUsage(usage: {
    inputTokens?: number | undefined;
    outputTokens?: number | undefined;
  }): void {
    this.#inputTokens += usage.inputTokens ?? 0;
    this.#outputTokens += usage.outputTokens ?? 0;
  }

  get spent(): { calls: number; inputTokens: number; outputTokens: number } {
    return { calls: this.#calls, inputTokens: this.#inputTokens, outputTokens: this.#outputTokens };
  }

  get callsRemaining(): number {
    return Math.max(0, this.budget.maxCallsPerRun - this.#calls);
  }

  summary(): string {
    return `${this.#calls}/${this.budget.maxCallsPerRun} calls, ${this.#inputTokens} in / ${this.#outputTokens} out tokens`;
  }
}

export function aiBudgetFromEnv(env: Record<string, string | undefined>): AiBudget {
  const num = (name: string, fallback: number): number => {
    const raw = env[name];
    if (raw === undefined || raw.trim() === "") return fallback;
    const text = raw.trim();
    // Plain digits only. Number() would accept "1e3" as 1000, and a cost guard
    // should not read exponential notation as a thousand-fold increase. Amounts
    // are parsed the same way in core/money.ts.
    if (!/^\d+$/.test(text)) {
      throw new Error(`${name} must be a plain positive integer, got ${raw}`);
    }
    const value = Number(text);
    if (value < 1) {
      throw new Error(`${name} must be at least 1, got ${raw}`);
    }
    return value;
  };
  return {
    maxCallsPerRun: num("REHEARSAL_AI_MAX_CALLS", DEFAULT_AI_BUDGET.maxCallsPerRun),
    maxOutputTokensPerCall: num(
      "REHEARSAL_AI_MAX_OUTPUT_TOKENS",
      DEFAULT_AI_BUDGET.maxOutputTokensPerCall,
    ),
    maxInputChars: num("REHEARSAL_AI_MAX_INPUT_CHARS", DEFAULT_AI_BUDGET.maxInputChars),
  };
}
