import { createAnthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";
import { type CapViolation, type Caps, DEFAULT_CAPS, checkCaps } from "../core/caps";
import { type Scenario, validateScenario } from "../core/scenario";
import { AiBudgetTracker } from "./budget";
import { buildPlannerPrompt } from "./prompt";

/**
 * Turns a plain-English business description into a scenario.
 *
 * The model's output is NEVER executed. It is parsed, then put through the same
 * Zod schema a hand-written scenario must pass, then through the spend caps.
 * Safety does not depend on the model complying with the prompt: it depends on
 * the schema and the caps, both of which run on whatever comes back.
 */

export const DEFAULT_PLANNER_MODEL = "claude-sonnet-5";

export type GenerateFn = (args: {
  system: string;
  prompt: string;
  maxOutputTokens: number;
}) => Promise<{
  text: string;
  usage?: { inputTokens?: number | undefined; outputTokens?: number | undefined };
}>;

export type PlanOutcome =
  | { readonly ok: true; readonly scenario: Scenario; readonly raw: string }
  | { readonly ok: false; readonly reason: "refused-by-model"; readonly detail: string; readonly raw: string }
  | { readonly ok: false; readonly reason: "unparseable"; readonly detail: string; readonly raw: string }
  | { readonly ok: false; readonly reason: "schema-invalid"; readonly errors: string[]; readonly raw: string }
  | { readonly ok: false; readonly reason: "over-caps"; readonly violations: CapViolation[]; readonly raw: string };

/**
 * Pulls the JSON object out of a model reply. Models wrap output in prose or
 * code fences despite being told not to, and that is a formatting quirk rather
 * than grounds to reject a scenario.
 */
export function extractJsonObject(
  text: string,
): { ok: true; value: unknown } | { ok: false; detail: string } {
  const attempt = (candidate: string): unknown | undefined => {
    try {
      return JSON.parse(candidate);
    } catch {
      return undefined;
    }
  };

  const trimmed = text.trim();
  if (trimmed === "") return { ok: false, detail: "the model returned nothing" };

  const candidates: string[] = [trimmed];

  // ```json ... ``` or ``` ... ```
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fenced?.[1] !== undefined) candidates.push(fenced[1].trim());

  // Prose either side of the object.
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first !== -1 && last > first) candidates.push(trimmed.slice(first, last + 1));

  for (const candidate of candidates) {
    const value = attempt(candidate);
    if (value === undefined) continue;
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return { ok: false, detail: "the model returned JSON that is not an object" };
    }
    return { ok: true, value };
  }
  return { ok: false, detail: "no JSON object could be parsed from the reply" };
}

/** Lengths for text the model writes and a terminal later prints. */
export const MAX_MODEL_NAME_CHARS = 60;
export const MAX_MODEL_DESCRIPTION_CHARS = 200;

/**
 * Model-written text is printed to the operator's terminal. Control and format
 * characters (escape sequences, bidi overrides, zero-width marks) can rewrite
 * what the operator sees there, so they become spaces before anything prints.
 * Truncation is by code point, so it never splits a character in half.
 */
export function cleanModelText(raw: string, maxChars: number): string {
  const flat = raw.replace(/[\p{Cc}\p{Cf}]+/gu, " ").replace(/\s+/g, " ").trim();
  const chars = Array.from(flat);
  return chars.length <= maxChars ? flat : chars.slice(0, maxChars).join("").trimEnd();
}

/** The same stripping without truncation, for a line about to be printed whatever its source. */
export function printable(line: string): string {
  return line.replace(/[\p{Cc}\p{Cf}]+/gu, " ");
}

/**
 * Every string in a parsed reply, keys included, with control and format
 * characters stripped. Run before validation, so whatever survives (step
 * labels, notes, item names, the saved plan, PayPal request bodies, and the
 * schema's own error messages, which echo values and keys) is already clean.
 */
export function stripControlDeep(value: unknown): unknown {
  if (typeof value === "string") return printable(value);
  if (Array.isArray(value)) return value.map(stripControlDeep);
  if (typeof value === "object" && value !== null) {
    // fromEntries defines own properties, so a "__proto__" key cannot reach the prototype.
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [printable(k), stripControlDeep(v)]),
    );
  }
  return value;
}

export const MAX_MODEL_REFUSAL_CHARS = 300;
export const MAX_PLAN_ERROR_CHARS = 300;
/** A reply can fail the schema in hundreds of places; the first few say enough. */
export const MAX_PLAN_ERRORS = 20;

function cleanErrors(errors: readonly string[]): string[] {
  const kept = errors.slice(0, MAX_PLAN_ERRORS).map((e) => cleanModelText(e, MAX_PLAN_ERROR_CHARS));
  const dropped = errors.length - kept.length;
  return dropped > 0 ? [...kept, `and ${dropped} more`] : kept;
}

function cleanNames(scenario: Scenario): Scenario {
  const description =
    scenario.profile.description === undefined
      ? ""
      : cleanModelText(scenario.profile.description, MAX_MODEL_DESCRIPTION_CHARS);
  const { description: _dropped, ...profile } = scenario.profile;
  return {
    ...scenario,
    name: cleanModelText(scenario.name, MAX_MODEL_NAME_CHARS) || "unnamed scenario",
    profile: {
      ...profile,
      name: cleanModelText(scenario.profile.name, MAX_MODEL_NAME_CHARS) || "unnamed business",
      ...(description === "" ? {} : { description }),
    },
  };
}

function refusalOf(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = (value as Record<string, unknown>)["refusal"];
  return typeof raw === "string" && raw.trim() !== "" ? raw.trim() : null;
}

export async function planScenario(
  args: {
    description: string;
    allowedEventOrigins: readonly string[];
    caps?: Caps;
    /** Our own steering, kept outside the untrusted fence. */
    extraInstruction?: string;
  },
  deps: { generate: GenerateFn; budget?: AiBudgetTracker },
): Promise<PlanOutcome> {
  const caps = args.caps ?? DEFAULT_CAPS;
  const budget = deps.budget ?? new AiBudgetTracker();

  // Sized before it reaches the model, and before a call is even reserved.
  budget.assertInputWithinLimit(args.description, "business description");

  const { system, prompt } = buildPlannerPrompt({
    description: args.description,
    allowedEventOrigins: args.allowedEventOrigins,
    caps,
    ...(args.extraInstruction === undefined ? {} : { extraInstruction: args.extraInstruction }),
  });

  budget.beginCall();
  const result = await deps.generate({
    system,
    prompt,
    maxOutputTokens: budget.budget.maxOutputTokensPerCall,
  });
  budget.recordUsage(result.usage ?? {});

  const raw = result.text;
  const parsed = extractJsonObject(raw);
  if (!parsed.ok) {
    return { ok: false, reason: "unparseable", detail: parsed.detail, raw };
  }

  const value = stripControlDeep(parsed.value);

  const refusal = refusalOf(value);
  if (refusal !== null) {
    return {
      ok: false,
      reason: "refused-by-model",
      detail: cleanModelText(refusal, MAX_MODEL_REFUSAL_CHARS) || "refused",
      raw,
    };
  }

  // The same gate a hand-written scenario passes. Host pinning and the event
  // allowlist are enforced here, so no reply can reach live PayPal or an
  // unapproved target however it was produced.
  const validated = validateScenario(value, {
    allowedEventOrigins: args.allowedEventOrigins,
  });
  if (!validated.ok) {
    return { ok: false, reason: "schema-invalid", errors: cleanErrors(validated.errors), raw };
  }

  const violations = checkCaps(validated.scenario, caps);
  if (violations.length > 0) {
    return {
      ok: false,
      reason: "over-caps",
      violations: violations.map((v) => ({ ...v, message: cleanModelText(v.message, MAX_PLAN_ERROR_CHARS) })),
      raw,
    };
  }

  return { ok: true, scenario: cleanNames(validated.scenario), raw };
}

export function anthropicGenerator(opts: { apiKey: string; model: string }): GenerateFn {
  const provider = createAnthropic({ apiKey: opts.apiKey });
  return async ({ system, prompt, maxOutputTokens }) => {
    const res = await generateText({
      model: provider(opts.model),
      system,
      prompt,
      maxOutputTokens,
      // No temperature: claude-sonnet-5 does not support it and the SDK warns
      // that it is ignored. Planning is therefore NOT deterministic, which is
      // why nothing runs without --yes and why the schema and caps re-check
      // every reply rather than trusting a previously good one.
      //
      // The budget counts logical calls; this bounds what one call can cost in
      // transport retries, which the budget cannot see.
      maxRetries: 1,
    });
    return {
      text: res.text,
      usage: { inputTokens: res.usage?.inputTokens, outputTokens: res.usage?.outputTokens },
    };
  };
}
