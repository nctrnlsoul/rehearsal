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

  const refusal = refusalOf(parsed.value);
  if (refusal !== null) {
    return { ok: false, reason: "refused-by-model", detail: refusal, raw };
  }

  // The same gate a hand-written scenario passes. Host pinning and the event
  // allowlist are enforced here, so no reply can reach live PayPal or an
  // unapproved target however it was produced.
  const validated = validateScenario(parsed.value, {
    allowedEventOrigins: args.allowedEventOrigins,
  });
  if (!validated.ok) {
    return { ok: false, reason: "schema-invalid", errors: validated.errors, raw };
  }

  const violations = checkCaps(validated.scenario, caps);
  if (violations.length > 0) {
    return { ok: false, reason: "over-caps", violations, raw };
  }

  return { ok: true, scenario: validated.scenario, raw };
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
