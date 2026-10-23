import type { RunState } from "../core/runState";
import type { Scenario } from "../core/scenario";
import { FAILURE_CLASSES, type FailureClass, type Finding, type StoreSnapshot } from "./failureClasses";
import type { PlanOutcome } from "./planner";

/**
 * The edge-case finder: plan a scenario per known failure class, run it, read
 * the sample store's state, and say what broke.
 *
 * A class that could not be exercised is reported as inconclusive, never as a
 * pass. The difference between "we checked and it is fine" and "we did not
 * check" is the whole value of the report.
 */

export type ClassResult = {
  readonly classId: string;
  readonly title: string;
  readonly finding: Finding;
  /** Set when the class never ran, with the reason. */
  readonly skipped: string | null;
  readonly scenarioName: string | null;
  readonly runId: string | null;
};

export type FinderDeps = {
  plan: (cls: FailureClass, description: string) => Promise<PlanOutcome>;
  run: (scenario: Scenario) => Promise<RunState>;
  readStore: (sinceIso: string) => Promise<StoreSnapshot>;
  bankAvailable: () => number;
  log: (line: string) => void;
  now: () => Date;
};

function inconclusive(cls: FailureClass, actual: string, likelyFix: string): Finding {
  return {
    classId: cls.id,
    title: cls.title,
    verdict: "inconclusive",
    event: "none",
    expected: "the class to be exercised",
    actual,
    likelyFix,
  };
}

export async function runFinder(
  args: { description: string; only?: string | undefined },
  deps: FinderDeps,
): Promise<ClassResult[]> {
  const classes =
    args.only === undefined
      ? FAILURE_CLASSES
      : FAILURE_CLASSES.filter((c) => c.id === args.only);

  if (classes.length === 0) {
    throw new Error(
      `no failure class named ${String(args.only)}; known: ${FAILURE_CLASSES.map((c) => c.id).join(", ")}`,
    );
  }

  const results: ClassResult[] = [];

  for (const cls of classes) {
    deps.log("");
    deps.log(`=== ${cls.id}: ${cls.title} ===`);

    if (!cls.supported) {
      deps.log(`  not reachable in this version: ${cls.unsupportedReason ?? "no reason recorded"}`);
      results.push({
        classId: cls.id,
        title: cls.title,
        finding: cls.check({ orders: [], eventCount: 0, unverifiedCount: 0 }, {
          version: 1,
          runId: "none",
          scenarioName: "none",
          currency: "USD",
          order: [],
          startedAt: "",
          updatedAt: "",
          halted: false,
          haltReason: null,
          meta: {},
          steps: {},
        }),
        skipped: cls.unsupportedReason ?? "not supported",
        scenarioName: null,
        runId: null,
      });
      continue;
    }

    if (cls.needsBankedPurchase && deps.bankAvailable() < 1) {
      const why = "no banked purchase is available, and each one needs a human approval click";
      deps.log(`  skipped: ${why}`);
      results.push({
        classId: cls.id,
        title: cls.title,
        finding: inconclusive(cls, why, "run bank:add, approve the link, then bank:confirm"),
        skipped: why,
        scenarioName: null,
        runId: null,
      });
      continue;
    }

    const outcome = await deps.plan(cls, args.description);
    if (!outcome.ok) {
      const detail =
        outcome.reason === "schema-invalid"
          ? outcome.errors.join("; ")
          : outcome.reason === "over-caps"
            ? outcome.violations.map((v) => v.message).join("; ")
            : outcome.detail;
      deps.log(`  no runnable plan (${outcome.reason}): ${detail}`);
      results.push({
        classId: cls.id,
        title: cls.title,
        finding: inconclusive(
          cls,
          `the planner produced nothing runnable: ${outcome.reason}`,
          `fix the plan or loosen the ask: ${detail}`,
        ),
        skipped: `planner ${outcome.reason}`,
        scenarioName: null,
        runId: null,
      });
      continue;
    }

    // Scoped a minute back, so the store read sees this run and not a backlog.
    const since = new Date(deps.now().getTime() - 60_000).toISOString();
    deps.log(`  running ${outcome.scenario.steps.length} step(s): ${outcome.scenario.name}`);
    const state = await deps.run(outcome.scenario);

    const store = await deps.readStore(since);
    const finding = cls.check(store, state);
    deps.log(`  ${finding.verdict.toUpperCase()}: ${finding.actual}`);

    results.push({
      classId: cls.id,
      title: cls.title,
      finding,
      skipped: null,
      scenarioName: outcome.scenario.name,
      runId: state.runId,
    });
  }

  return results;
}

/** Pure, so the report is testable and says only what the results hold. */
export function finderReportLines(results: readonly ClassResult[]): string[] {
  const lines: string[] = [];
  const count = (v: string) => results.filter((r) => r.finding.verdict === v).length;

  lines.push("# Edge-case finder report");
  lines.push("");
  lines.push(
    `- ${count("bug")} bug(s), ${count("ok")} passed, ${count("inconclusive")} inconclusive, of ${results.length} classes`,
  );
  lines.push("");

  for (const r of results) {
    const mark = r.finding.verdict === "bug" ? "BUG" : r.finding.verdict === "ok" ? "ok" : "inconclusive";
    lines.push(`## ${mark}  ${r.classId}`);
    lines.push("");
    lines.push(`- ${r.title}`);
    lines.push(`- PayPal event: \`${r.finding.event}\``);
    lines.push(`- Expected: ${r.finding.expected}`);
    lines.push(`- Actual: ${r.finding.actual}`);
    lines.push(`- Likely fix: ${r.finding.likelyFix}`);
    if (r.runId !== null) lines.push(`- Run: \`${r.runId}\``);
    if (r.skipped !== null) lines.push(`- Not run because: ${r.skipped}`);
    lines.push("");
  }

  const bugs = results.filter((r) => r.finding.verdict === "bug");
  lines.push(
    bugs.length === 0
      ? "No bugs found in the classes that were actually exercised. Read the inconclusive ones: they were not tested, which is not the same as passing."
      : `Found ${bugs.length} bug(s): ${bugs.map((b) => b.classId).join(", ")}.`,
  );

  return lines;
}
