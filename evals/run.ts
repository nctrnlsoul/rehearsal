import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { requiredEnv, optionalEnv } from "../src/adapters/env";
import { AiBudgetTracker, BudgetExceededError, DEFAULT_AI_BUDGET } from "../src/ai/budget";
import {
  type EvalCase,
  type EvalResult,
  evalReportLines,
  summariseEvals,
} from "../src/ai/evals";
import { DEFAULT_PLANNER_MODEL, anthropicGenerator, planScenario } from "../src/ai/planner";
import { UnsafeDescriptionError } from "../src/ai/prompt";
import { capsFromEnv } from "../src/core/caps";

/**
 * Runs the planner over every example description and scores it.
 *
 * This makes one model call per case, so it sets its own call budget rather than
 * inheriting the per-run default, and says so in the output. Nothing here
 * touches PayPal: it plans and scores, it never runs a scenario.
 */

const CASES_FILE = resolve(import.meta.dirname, "descriptions.json");
const STORE_ORIGIN = "https://sample-store.example";

function loadCases(): EvalCase[] {
  const raw: unknown = JSON.parse(readFileSync(CASES_FILE, "utf8"));
  const holder = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const list = Array.isArray(holder["cases"]) ? holder["cases"] : [];
  const cases: EvalCase[] = [];
  for (const entry of list) {
    if (typeof entry !== "object" || entry === null) continue;
    const rec = entry as Record<string, unknown>;
    const id = rec["id"];
    const description = rec["description"];
    const expect = rec["expect"];
    if (
      typeof id !== "string" ||
      typeof description !== "string" ||
      (expect !== "valid" && expect !== "refused")
    ) {
      throw new Error(`malformed eval case: ${JSON.stringify(entry).slice(0, 120)}`);
    }
    cases.push({ id, description, expect });
  }
  if (cases.length === 0) throw new Error("no eval cases were loaded");
  return cases;
}

const cases = loadCases();
const apiKey = requiredEnv("ANTHROPIC_API_KEY");
const model = optionalEnv("REHEARSAL_PLANNER_MODEL") ?? DEFAULT_PLANNER_MODEL;
const caps = capsFromEnv(process.env);
const generate = anthropicGenerator({ apiKey, model });

// One call per case, set explicitly so the deliberate spend is visible.
const budget = new AiBudgetTracker({
  ...DEFAULT_AI_BUDGET,
  maxCallsPerRun: cases.length + 2,
});

console.log(`running ${cases.length} eval cases with ${model}`);
console.log(`allowing ${budget.budget.maxCallsPerRun} model calls for this eval run`);
console.log("");

const results: EvalResult[] = [];

for (const testCase of cases) {
  let result: EvalResult;
  try {
    const outcome = await planScenario(
      {
        description: testCase.description,
        allowedEventOrigins: [STORE_ORIGIN],
        caps,
      },
      { generate, budget },
    );

    if (outcome.ok) {
      result = {
        id: testCase.id,
        expect: testCase.expect,
        outcome: "valid",
        refusedBy: "none",
        detail: `${outcome.scenario.steps.length} steps: ${outcome.scenario.steps.map((s) => s.kind).join(", ")}`,
      };
    } else if (outcome.reason === "refused-by-model") {
      result = {
        id: testCase.id,
        expect: testCase.expect,
        outcome: "refused",
        refusedBy: "model",
        detail: outcome.detail,
      };
    } else if (outcome.reason === "schema-invalid") {
      result = {
        id: testCase.id,
        expect: testCase.expect,
        outcome: "refused",
        refusedBy: "schema",
        detail: outcome.errors.slice(0, 2).join("; "),
      };
    } else if (outcome.reason === "over-caps") {
      result = {
        id: testCase.id,
        expect: testCase.expect,
        outcome: "refused",
        refusedBy: "caps",
        detail: outcome.violations.map((v) => v.code).join(", "),
      };
    } else {
      result = {
        id: testCase.id,
        expect: testCase.expect,
        outcome: "refused",
        refusedBy: "parser",
        detail: outcome.detail,
      };
    }
  } catch (e) {
    if (e instanceof UnsafeDescriptionError || e instanceof BudgetExceededError) {
      // Refused before the model was even asked, which still counts as refused.
      result = {
        id: testCase.id,
        expect: testCase.expect,
        outcome: "refused",
        refusedBy: "input-guard",
        detail: (e as Error).message,
      };
    } else {
      throw e;
    }
  }

  const mark = result.outcome === result.expect ? "ok " : "MISMATCH";
  console.log(
    `${mark}  ${testCase.id.padEnd(24)} ${result.outcome.padEnd(8)} by ${result.refusedBy}`,
  );
  results.push(result);
}

const summary = summariseEvals(results);
const report = evalReportLines(results, summary).join("\n");
const reportPath = resolve("runs", "evals.md");
mkdirSync(dirname(reportPath), { recursive: true });
writeFileSync(reportPath, `${report}\n`, "utf8");

console.log("");
console.log(report);
console.log("");
console.log(`report written to ${reportPath}`);
console.log(`model spend: ${budget.summary()}`);

process.exitCode = summary.mismatches.length === 0 ? 0 : 1;
