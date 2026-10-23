import type { RunState } from "../core/runState";
import type { Scenario } from "../core/scenario";
import {
  FAILURE_CLASSES,
  type FailureClass,
  type Finding,
  type ScenarioTemplate,
  type StoreSnapshot,
} from "./failureClasses";
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
  /** What the planner proposed that the template did not take, so nothing is dropped unseen. */
  readonly ignored: readonly string[];
};

export type FinderDeps = {
  plan: (cls: FailureClass, description: string) => Promise<PlanOutcome>;
  /** The schema and the caps, re-run on the filled template before anything executes. */
  validate: (
    candidate: unknown,
  ) => { ok: true; scenario: Scenario } | { ok: false; errors: string[] };
  /**
   * The mode is passed by the finder, not chosen by the caller, and its type
   * admits only one value: no wiring can make the finder register a webhook.
   */
  run: (scenario: Scenario, opts: { webhookMode: "reuse-only" }) => Promise<RunState>;
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

function getPath(from: unknown, path: string): unknown {
  let cur: unknown = from;
  for (const key of path.split(".")) {
    if (typeof cur !== "object" || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

/** Sets a leaf only where the template already has its parent, so a path cannot grow the shape. */
function setPath(into: unknown, path: string, value: unknown): boolean {
  const keys = path.split(".");
  const leaf = keys.pop()!;
  const parent = keys.length === 0 ? into : getPath(into, keys.join("."));
  if (typeof parent !== "object" || parent === null) return false;
  (parent as Record<string, unknown>)[leaf] = value;
  return true;
}

/**
 * Builds the scenario a class runs: the template's steps, with only the
 * fillable values taken from the planner. Pure.
 *
 * The planner's steps are never run as given. Extra steps, changed kinds,
 * needs or from, and its own webhook block are left out and listed, and the
 * webhook target is ours, never the model's.
 */
export function applyTemplate(
  template: ScenarioTemplate,
  planned: Scenario,
  webhookTarget: string | null,
): { candidate: Record<string, unknown>; ignored: string[] } {
  const ignored: string[] = [];
  const plannedById = new Map(planned.steps.map((s) => [s.id, s]));
  const templateIds = new Set(template.steps.map((s) => s.id));

  for (const p of planned.steps) {
    if (!templateIds.has(p.id)) ignored.push(`extra step ${p.id} (${p.kind})`);
  }

  const steps = template.steps.map((t) => {
    const merged = structuredClone(t) as Record<string, unknown>;
    const p = plannedById.get(t.id);
    if (p === undefined) return merged;
    if (p.kind !== t.kind) {
      ignored.push(`step ${t.id} planned as ${p.kind}, template is ${t.kind}`);
      return merged;
    }

    for (const path of template.fillable[t.id] ?? []) {
      const value = getPath(p, path);
      if (value === undefined) continue;
      const current = getPath(merged, path);
      if (current !== undefined && typeof value !== typeof current) {
        ignored.push(`${t.id}.${path} of the wrong type`);
        continue;
      }
      if (!setPath(merged, path, value)) ignored.push(`${t.id}.${path} has nowhere to go`);
    }

    // Anything the planner set that did not survive the merge was ignored.
    for (const [key, value] of Object.entries(p)) {
      if (key === "label") continue;
      if (JSON.stringify(value) !== JSON.stringify(merged[key])) {
        ignored.push(`${t.id}.${key}`);
      }
    }
    return merged;
  });

  const candidate: Record<string, unknown> = {
    version: 1,
    name: planned.name,
    profile: planned.profile,
    currency: planned.currency,
    steps,
  };
  if (template.needsWebhook && webhookTarget !== null) {
    candidate["webhook"] = { target: webhookTarget, eventTypes: ["*"] };
  }
  if (
    planned.webhook !== undefined &&
    JSON.stringify(planned.webhook) !== JSON.stringify(candidate["webhook"])
  ) {
    ignored.push("the planner's webhook block");
  }
  return { candidate, ignored };
}

export async function runFinder(
  args: {
    description: string;
    only?: string | undefined;
    /** The store's exact webhook handler URL. Null means no class needing a webhook can run. */
    webhookTarget: string | null;
  },
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
        ignored: [],
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
        ignored: [],
      });
      continue;
    }

    // Checked before planning, so a class that cannot run costs no model call.
    const template = cls.template;
    if (template === null || (template.needsWebhook && args.webhookTarget === null)) {
      const why =
        template === null
          ? "this class has no fixed scenario, so there is nothing safe to run"
          : "this class resends to the store's webhook, and no store webhook URL is configured";
      deps.log(`  skipped: ${why}`);
      results.push({
        classId: cls.id,
        title: cls.title,
        finding: inconclusive(cls, why, "configure the store origin, or give the class a template"),
        skipped: why,
        scenarioName: null,
        runId: null,
        ignored: [],
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
        ignored: [],
      });
      continue;
    }

    const applied = applyTemplate(template, outcome.scenario, args.webhookTarget);
    for (const what of applied.ignored) deps.log(`  ignored from the plan: ${what}`);

    const checked = deps.validate(applied.candidate);
    if (!checked.ok) {
      const detail = checked.errors.join("; ");
      deps.log(`  the filled template did not validate: ${detail}`);
      results.push({
        classId: cls.id,
        title: cls.title,
        finding: inconclusive(
          cls,
          "the template filled with the planner's values did not pass the schema and caps",
          `fix the template or the values: ${detail}`,
        ),
        skipped: "filled template invalid",
        scenarioName: null,
        runId: null,
        ignored: applied.ignored,
      });
      continue;
    }
    const scenario = checked.scenario;

    // Scoped a minute back, so the store read sees this run and not a backlog.
    const since = new Date(deps.now().getTime() - 60_000).toISOString();
    deps.log(`  running ${scenario.steps.length} step(s): ${scenario.name}`);
    const state = await deps.run(scenario, { webhookMode: "reuse-only" });

    const store = await deps.readStore(since);
    const finding = cls.check(store, state);
    deps.log(`  ${finding.verdict.toUpperCase()}: ${finding.actual}`);

    results.push({
      classId: cls.id,
      title: cls.title,
      finding,
      skipped: null,
      scenarioName: scenario.name,
      runId: state.runId,
      ignored: applied.ignored,
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
    if (r.ignored.length > 0) lines.push(`- Ignored from the plan: ${r.ignored.join("; ")}`);
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
