// Writes console/fixtures/plans.json from real planner outputs saved by the CLI.
//
// The console renders plans; it does not judge them. So everything a judgment
// produces (the digest a run must match, and the totals the spend caps count)
// is computed here by the engine itself and stored with the plan. The inputs
// live in runs/plans/, which is not committed, so this runs locally and its
// output is what the console ships.
//
//   node node_modules/tsx/dist/cli.mjs scripts/console-plan-fixtures.mts

import { readFileSync, writeFileSync } from "node:fs";
import { gateScenario, scenarioDigest } from "../src/app/runtime";
import { DEFAULT_CAPS, checkCaps } from "../src/core/caps";
import { fromMinor, toMinor } from "../src/core/money";
import type { Scenario } from "../src/core/scenario";

const PLANS = [
  { file: "plan-20261023193216", description: null },
  { file: "plan-20261024025344-a96635", description: "an open dispute waiting for my response" },
];

// The run total exactly as checkCaps counts it: probe the cap until it trips.
function capsTotal(s: Scenario): string {
  let lo = 0n;
  let hi = DEFAULT_CAPS.maxTotalMinor;
  while (lo < hi) {
    const mid = (lo + hi) / 2n;
    const over = checkCaps(s, { ...DEFAULT_CAPS, maxTotalMinor: mid }).some((v) => v.code === "run-total-too-large");
    if (over) lo = mid + 1n;
    else hi = mid;
  }
  return fromMinor(lo, s.currency);
}

const out = PLANS.map(({ file, description }) => {
  const raw = JSON.parse(readFileSync(`runs/plans/${file}.json`, "utf8"));
  const g = gateScenario(raw, { allowedEventOrigins: [], caps: DEFAULT_CAPS });
  if (!g.ok) throw new Error(`${file} does not pass the gate: ${g.errors.join("; ")}`);
  const s = g.scenario;
  const amounts = s.steps.flatMap((st) => ("amount" in st && st.amount !== undefined ? [toMinor(st.amount, s.currency)] : []));
  return {
    plan: file,
    description,
    sha256: scenarioDigest(s),
    capsTotal: capsTotal(s),
    largestStep: fromMinor(amounts.reduce((a, b) => (b > a ? b : a), 0n), s.currency),
    violations: checkCaps(s, DEFAULT_CAPS).length,
    scenario: s,
  };
});

writeFileSync(
  "console/fixtures/plans.json",
  `${JSON.stringify({ note: "Real planner outputs saved by the CLI in runs/plans/. sha256, capsTotal and largestStep were computed by the engine (scripts/console-plan-fixtures.mts). Nothing here calls a model.", caps: { perStep: fromMinor(DEFAULT_CAPS.maxStepAmountMinor, "USD"), perRun: fromMinor(DEFAULT_CAPS.maxTotalMinor, "USD"), steps: DEFAULT_CAPS.maxSteps, disputes: DEFAULT_CAPS.maxDisputes }, plans: out }, null, 2)}\n`,
);
console.error(out.map((p) => `${p.plan} sha256 ${p.sha256} capsTotal ${p.capsTotal} largest ${p.largestStep} violations ${p.violations}`).join("\n"));
