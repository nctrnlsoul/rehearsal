import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { z } from "zod";
import { AiBudgetTracker, aiBudgetFromEnv } from "../ai/budget";
import { FAILURE_CLASSES } from "../ai/failureClasses";
import { finderReportLines, runFinder } from "../ai/finder";
import {
  DEFAULT_PLANNER_MODEL,
  type GenerateFn,
  MAX_PLAN_ERRORS,
  MAX_PLAN_ERROR_CHARS,
  cleanModelText,
  planScenario,
} from "../ai/planner";
import { type AppRole, optionalEnv, requiredEnv } from "../adapters/env";
import type { PaypalClient } from "../adapters/paypal";
import {
  DEFAULT_FINDER_DESCRIPTION,
  NEEDS_BANKED_PURCHASE,
  RUN_ID_PATTERN,
  type RuntimePaths,
  bankShortfall,
  bankStore,
  eventOriginsFromEnv,
  executeWithPersistence,
  finderDepsFrom,
  gateScenario,
  loadResume,
  newRunId,
  runStateStore,
  scenarioDigest,
  storeStateReader,
} from "../app/runtime";
import { type Caps, capsFromEnv } from "../core/caps";
import { assertAllowedEventTarget, webhookHandlerUrl } from "../core/eventTarget";
import { fromMinor } from "../core/money";
import { type Bank, availablePurchases } from "../core/purchaseBank";
import { type RunState, summarize } from "../core/runState";
import type { Scenario } from "../core/scenario";
import { dryRunLines } from "../executor/dryRun";
import { SCENARIO_DIGEST_KEY } from "../executor/executor";
import { runReportLines } from "../executor/report";
import { guardTransport, safeErrorText } from "./output";

/**
 * REHEARSAL as an MCP server, stdio only. Every tool is a thin front
 * end over the same planner, scenario gate, executor, bank and finder the CLI
 * uses; nothing here decides what a scenario may do.
 *
 * All tool input is untrusted: it comes from a model that may be reading text
 * an attacker wrote. Anything that creates sandbox records needs confirm: true,
 * and the human approves that call in the client.
 */

type Env = Record<string, string | undefined>;

export type ServerDeps = {
  /** Read at call time, never echoed. */
  readonly env: Env;
  readonly paths: RuntimePaths;
  readonly makeClient: (role: AppRole) => PaypalClient;
  readonly makeGenerator: (opts: { apiKey: string; model: string }) => GenerateFn;
  /** For the sample store's state endpoint. */
  readonly fetchImpl?: typeof fetch;
  readonly now: () => Date;
  readonly sleep: (ms: number) => Promise<void>;
  /** Diagnostics only, to stderr. Lines are already cleaned and capped. */
  readonly log: (line: string) => void;
};

export const SERVER_NAME = "rehearsal";
export const SERVER_VERSION = "0.7.3";

export const MAX_DESCRIPTION_CHARS = 4000;
export const MAX_SCENARIO_JSON_CHARS = 32_768;
/** Counted by the SDK before any schema runs, so a huge argument tree is refused cheaply. */
export const MAX_INPUT_ELEMENTS = 4000;
const MAX_DETAIL_CHARS = 200;
const MAX_LOG_CHARS = 300;

/** Session ceilings. The CLI's caps are per invocation; a server lives across many calls. */
export const SESSION_LIMIT_VARS = {
  modelCalls: "REHEARSAL_MCP_MAX_MODEL_CALLS",
  executions: "REHEARSAL_MCP_MAX_RUNS",
} as const;
export const DEFAULT_SESSION_LIMITS = { modelCalls: 20, executions: 10 };

const RUN_ID_MESSAGE = "run id must look like 20261023231552-60ea96";

// ------------------------------------------------------------------ input schemas

const scenarioInput = z
  .record(z.string(), z.unknown())
  .refine((v) => JSON.stringify(v).length <= MAX_SCENARIO_JSON_CHARS, {
    message: `scenario must be at most ${MAX_SCENARIO_JSON_CHARS} characters of JSON`,
  })
  .describe("A REHEARSAL scenario object, as returned by plan_scenario.");

const descriptionInput = z
  .string()
  .min(1)
  .max(MAX_DESCRIPTION_CHARS)
  .describe("Plain-English description of the business and the situation to rehearse.");

const confirmInput = z
  .boolean()
  .optional()
  .describe("True executes against the PayPal sandbox. Absent or false executes nothing.");

const runIdInput = z.string().regex(RUN_ID_PATTERN, RUN_ID_MESSAGE);

// Ids are matched against the class list after parsing, and a regex message
// never echoes the value, unlike an enum's.
const classIdInput = z
  .string()
  .regex(/^[a-z][a-z-]{0,39}$/, "class id must be lower-case letters and dashes")
  .optional()
  .describe(`One failure class to run: ${FAILURE_CLASSES.map((c) => c.id).join(", ")}.`);

// ------------------------------------------------------------------ helpers

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

const ok = (lines: readonly string[]): ToolResult => ({
  content: [{ type: "text", text: lines.join("\n") }],
});
const refused = (lines: readonly string[]): ToolResult => ({ ...ok(lines), isError: true });

class ConfigError extends Error {}

function cleanErrors(errors: readonly string[]): string[] {
  const kept = errors.slice(0, MAX_PLAN_ERRORS).map((e) => `  ${cleanModelText(e, MAX_PLAN_ERROR_CHARS)}`);
  return errors.length > kept.length ? [...kept, `  and ${errors.length - kept.length} more`] : kept;
}

function readSessionLimit(env: Env, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  // Plain digits only, as for every other cap. The value is never echoed.
  if (!/^\d+$/.test(raw.trim()) || Number(raw.trim()) < 1) {
    throw new ConfigError(`${name} must be a plain positive integer`);
  }
  return Number(raw.trim());
}

export function startServer(deps: ServerDeps, transport: Transport): Promise<McpServer> {
  const server = createRehearsalServer(deps);
  // The guard goes on before connect, so not even the initialize reply skips it.
  return server.connect(guardTransport(transport)).then(() => server);
}

export function createRehearsalServer(deps: ServerDeps): McpServer {
  const log = (line: string) => deps.log(cleanModelText(line, MAX_LOG_CHARS));

  const session = { modelCalls: 0, executions: 0 };
  /** One executing call at a time: two runs drawing on one bank file could double-claim. */
  let activeRunId: string | null = null;
  let busy = false;

  const limits = () => ({
    modelCalls: readSessionLimit(deps.env, SESSION_LIMIT_VARS.modelCalls, DEFAULT_SESSION_LIMITS.modelCalls),
    executions: readSessionLimit(deps.env, SESSION_LIMIT_VARS.executions, DEFAULT_SESSION_LIMITS.executions),
  });

  /** Origins and caps, read per call. Errors name variables, never values. */
  const config = (): { origins: string[]; caps: Caps } => {
    const origins = eventOriginsFromEnv(deps.env);
    if (!origins.ok) throw new ConfigError(origins.error);
    let caps: Caps;
    try {
      caps = capsFromEnv(deps.env);
    } catch {
      throw new ConfigError(
        "a cap variable (REHEARSAL_MAX_STEP_AMOUNT, REHEARSAL_MAX_RUN_TOTAL, REHEARSAL_MAX_STEPS or REHEARSAL_MAX_DISPUTES) is malformed",
      );
    }
    return { origins: origins.origins, caps };
  };

  const aiBudget = (): AiBudgetTracker => {
    try {
      return new AiBudgetTracker(aiBudgetFromEnv(deps.env));
    } catch {
      throw new ConfigError(
        "an AI budget variable (REHEARSAL_AI_MAX_CALLS, REHEARSAL_AI_MAX_OUTPUT_TOKENS or REHEARSAL_AI_MAX_INPUT_CHARS) is malformed",
      );
    }
  };

  /** The model, with every call also counted against the session ceiling. */
  const generator = (): GenerateFn => {
    const apiKey = requiredEnv("ANTHROPIC_API_KEY", deps.env);
    const model = optionalEnv("REHEARSAL_PLANNER_MODEL", deps.env) ?? DEFAULT_PLANNER_MODEL;
    const inner = deps.makeGenerator({ apiKey, model });
    const ceiling = limits().modelCalls;
    return (args) => {
      if (session.modelCalls >= ceiling) {
        throw new ConfigError(
          `this server has made its ${ceiling} permitted model calls; restart it to reset (${SESSION_LIMIT_VARS.modelCalls})`,
        );
      }
      session.modelCalls += 1;
      return inner(args);
    };
  };

  const readBank = (): Bank => bankStore(deps.paths).read();

  const bankLines = (scenario: Scenario, state: RunState | null = null): { lines: string[]; short: boolean } => {
    // On a resume, a dispute step that already succeeded has drawn its purchase.
    const pending =
      state === null
        ? scenario
        : { ...scenario, steps: scenario.steps.filter((s) => state.steps[s.id]?.status !== "succeeded") };
    const gap = bankShortfall(pending, readBank());
    if (gap.needed === 0) return { lines: ["  purchase bank   not used by this scenario"], short: false };
    if (gap.short) {
      return {
        lines: [
          `  purchase bank   BLOCKED: ${NEEDS_BANKED_PURCHASE}`,
          `                  ${gap.needed} dispute step(s), ${gap.available} usable banked purchase(s)`,
        ],
        short: true,
      };
    }
    return {
      lines: [`  purchase bank   draws ${gap.needed} of ${gap.available} usable banked purchase(s)`],
      short: false,
    };
  };

  const capLines = (caps: Caps): string[] => {
    const c = caps.currency;
    return [
      `  caps            within: ${c} ${fromMinor(caps.maxStepAmountMinor, c)} per step, ${c} ${fromMinor(caps.maxTotalMinor, c)} per run, ${caps.maxSteps} steps, ${caps.maxDisputes} disputes`,
    ];
  };

  /** Schema, allowlist and caps, then the report a dry run gives. */
  const gate = (input: unknown): { ok: true; scenario: Scenario; caps: Caps; lines: string[] } | { ok: false; lines: string[] } => {
    const { origins, caps } = config();
    const checked = gateScenario(input, { allowedEventOrigins: origins, caps });
    if (!checked.ok) {
      return {
        ok: false,
        lines: ["INVALID: the scenario does not pass the schema, the event-target allowlist or the caps. Nothing would run.", ...cleanErrors(checked.errors)],
      };
    }
    const webhook =
      checked.scenario.webhook === undefined
        ? "  event target    none declared"
        : "  event target    on the allowlist";
    return {
      ok: true,
      scenario: checked.scenario,
      caps,
      lines: [...dryRunLines(checked.scenario), "", "  checks", "  schema          passed", webhook, ...capLines(caps)],
    };
  };

  /** Every handler funnels through this, so a thrown error is never echoed raw. */
  const guarded =
    <A>(name: string, fn: (args: A) => Promise<ToolResult> | ToolResult) =>
    async (args: A): Promise<ToolResult> => {
      try {
        return await fn(args);
      } catch (e) {
        if (e instanceof ConfigError) return refused([`REFUSED: ${e.message}. Nothing ran.`]);
        const ref = randomBytes(4).toString("hex");
        // The name only: a message can carry a PayPal body or an env value.
        log(`${name} failed (ref ${ref}): ${e instanceof Error ? e.name : typeof e}`);
        return refused([`FAILED: ${safeErrorText(e, ref)}`]);
      }
    };

  const statusLines = (state: RunState): string[] => {
    const sum = summarize(state);
    const verdict = state.halted
      ? "HALTED"
      : sum.complete
        ? "COMPLETE"
        : activeRunId === state.runId
          ? "RUNNING in this server"
          : `INCOMPLETE: ${sum.pending} step(s) not run`;
    const lines = [
      `run ${state.runId}: ${state.scenarioName}`,
      `  verdict        ${verdict}`,
      ...(state.halted ? [`  halt reason    ${cleanModelText(state.haltReason ?? "not recorded", 300)}`] : []),
      `  started        ${state.startedAt}`,
      `  last update    ${state.updatedAt}`,
      `  steps          ${sum.succeeded} succeeded, ${sum.failed} failed, ${sum.unknown} unknown, ${sum.pending} not run, of ${sum.total}`,
      "",
    ];
    for (const id of state.order) {
      const rec = state.steps[id];
      if (rec === undefined) continue;
      const detail = rec.detail === "" ? "" : `  ${cleanModelText(rec.detail, MAX_DETAIL_CHARS)}`;
      lines.push(`  ${id.padEnd(16)} ${rec.kind.padEnd(22)} ${rec.status.padEnd(9)} attempts ${rec.attempts}${detail}`);
    }
    if (sum.ids.length > 0) {
      lines.push("", "  PayPal ids created");
      for (const row of sum.ids) lines.push(`    ${row.step}  ${row.label}  ${row.value}`);
    }
    return lines;
  };

  /** Claims the single execution slot, or says why not. */
  const claimSlot = (): string | null => {
    if (busy) return "another run or finder pass is in progress in this server";
    const ceiling = limits().executions;
    if (session.executions >= ceiling) {
      return `this server has executed its ${ceiling} permitted runs; restart it to reset (${SESSION_LIMIT_VARS.executions})`;
    }
    busy = true;
    session.executions += 1;
    return null;
  };

  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { maxToolInputElements: MAX_INPUT_ELEMENTS },
  );

  // ---------------------------------------------------------------- plan_scenario

  server.registerTool(
    "plan_scenario",
    {
      title: "Plan a sandbox scenario",
      description:
        "Turns a plain-English business description into a REHEARSAL scenario for the PayPal sandbox, checked against the schema, the event-target allowlist and the spend caps. Makes one model call. Executes nothing.",
      inputSchema: { description: descriptionInput },
      // Not read-only: it spends a model call and saves the plan under runs/plans.
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    guarded("plan_scenario", async ({ description }: { description: string }) => {
      const { origins, caps } = config();
      const budget = aiBudget();
      const outcome = await planScenario(
        { description, allowedEventOrigins: origins, caps },
        { generate: generator(), budget },
      );

      if (!outcome.ok) {
        switch (outcome.reason) {
          case "refused-by-model":
            return refused([`REFUSED by the model: ${outcome.detail}`]);
          case "unparseable":
            return refused([`REFUSED: ${outcome.detail}`]);
          case "schema-invalid":
            return refused(["REFUSED: the plan does not pass the scenario schema.", ...outcome.errors.map((e) => `  ${e}`)]);
          case "over-caps":
            return refused(["REFUSED: the plan exceeds the spend caps.", ...outcome.violations.map((v) => `  ${v.code}: ${v.message}`)]);
        }
      }

      const scenario = outcome.scenario;
      // Saved like the CLI's plan: planning is not deterministic, so the file
      // is the record of what was proposed.
      const stamp = newRunId(deps.now());
      const planPath = resolve(deps.paths.runsDir, "plans", `plan-${stamp}.json`);
      mkdirSync(dirname(planPath), { recursive: true });
      writeFileSync(planPath, `${JSON.stringify(scenario, null, 2)}\n`, "utf8");

      const bank = bankLines(scenario);
      return ok([
        "PLANNED. Nothing has run.",
        "",
        ...dryRunLines(scenario),
        "",
        "  checks",
        "  schema          passed",
        scenario.webhook === undefined ? "  event target    none declared" : "  event target    on the allowlist",
        ...capLines(caps),
        ...bank.lines,
        "",
        `plan saved to ${planPath}`,
        `model calls: ${budget.summary()}`,
        "",
        "scenario:",
        JSON.stringify(scenario, null, 2),
      ]);
    }),
  );

  // ---------------------------------------------------------------- dry_run

  server.registerTool(
    "dry_run",
    {
      title: "Dry-run a scenario",
      description:
        "Validates a scenario against the schema, the spend caps, the event-target allowlist and the purchase bank, and reports what a run would do. Makes no network calls.",
      inputSchema: { scenario: scenarioInput },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guarded("dry_run", ({ scenario }: { scenario: Record<string, unknown> }) => {
      const checked = gate(scenario);
      if (!checked.ok) return refused(checked.lines);
      const bank = bankLines(checked.scenario);
      return ok([...checked.lines, ...bank.lines, "", bank.short ? "A run would be refused until the bank has enough purchases." : "A run would be accepted."]);
    }),
  );

  // ---------------------------------------------------------------- run_scenario

  server.registerTool(
    "run_scenario",
    {
      title: "Run a scenario in the PayPal sandbox",
      description:
        "Executes a scenario against the PayPal sandbox when confirm is true; otherwise returns the dry run and executes nothing. Applies the scenario schema, the spend caps, the event-target allowlist, the purchase bank check, sandbox host pinning, idempotency keys and resumable run state. With resume, continues an interrupted run started from the same scenario; a halted run is not retried here.",
      inputSchema: {
        scenario: scenarioInput,
        confirm: confirmInput,
        resume: runIdInput.optional().describe("Run id of an interrupted run to continue."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    guarded(
      "run_scenario",
      async ({ scenario: input, confirm, resume }: { scenario: Record<string, unknown>; confirm?: boolean | undefined; resume?: string | undefined }) => {
        const checked = gate(input);
        if (!checked.ok) return refused(checked.lines);
        const scenario = checked.scenario;

        let resumeState: RunState | null = null;
        if (resume !== undefined) {
          const loaded = loadResume(deps.paths.runsDir, resume, null, deps.now().toISOString());
          if (!loaded.ok) {
            return refused([
              `REFUSED: ${cleanModelText(loaded.error, 400)}. Nothing ran.`,
              ...(loaded.halted
                ? [
                    "The halting step may already have written to PayPal. Retrying it is a CLI-only action, after checking:",
                    `  npm run rehearsal -- run <scenario.json> --resume ${resume} --retry <stepId>`,
                  ]
                : []),
            ]);
          }
          resumeState = loaded.state;
          // Strict here: a run with no recorded digest predates them and resumes only from the CLI.
          if (resumeState.meta[SCENARIO_DIGEST_KEY] !== scenarioDigest(scenario)) {
            return refused([
              `REFUSED: run ${resume} was not started from this exact scenario, so it cannot be resumed. Nothing ran.`,
            ]);
          }
        }

        const bank = bankLines(scenario, resumeState);
        if (confirm !== true) {
          return ok([...checked.lines, ...bank.lines, "", "Nothing ran: confirm was not true."]);
        }
        if (bank.short) {
          return refused([`REFUSED: ${NEEDS_BANKED_PURCHASE}. Nothing ran.`, ...bank.lines]);
        }

        // Before the slot, so missing credentials cost no execution.
        const seller = deps.makeClient("seller");
        const buyer = deps.makeClient("buyer");
        const slot = claimSlot();
        if (slot !== null) return refused([`REFUSED: ${slot}. Nothing ran.`]);
        try {
          const runId = resume ?? newRunId(deps.now());
          activeRunId = runId;
          log(`run ${runId} starting: ${scenario.name}`);
          const state = await executeWithPersistence(
            { scenario, runId, resume: resumeState, webhookMode: "register" },
            { paths: deps.paths, seller, buyer, now: deps.now, sleep: deps.sleep, log, env: deps.env },
          );

          // The run has already written to PayPal, so a failed report write must
          // not hide its id: a caller told "failed" would run it again.
          const reportPath = resolve(deps.paths.runsDir, `${state.runId}.md`);
          let reportLine = `report written to ${reportPath}`;
          try {
            writeFileSync(reportPath, `${runReportLines(scenario, state).join("\n")}\n`, "utf8");
          } catch (e) {
            reportLine = `the report could not be written (${e instanceof Error ? e.name : "error"}); the run state is in runs/${state.runId}.json`;
          }

          const lines = [...statusLines(state), "", reportLine];
          return state.halted ? refused(lines) : ok(lines);
        } finally {
          busy = false;
          activeRunId = null;
        }
      },
    ),
  );

  // ---------------------------------------------------------------- run_status

  server.registerTool(
    "run_status",
    {
      title: "Run status",
      description: "Reports progress and step outcomes for a run id, read from the local run state.",
      inputSchema: { runId: runIdInput },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guarded("run_status", ({ runId }: { runId: string }) => {
      const state = runStateStore(deps.paths.runsDir, runId).read();
      if (state === null) return refused([`no run state found for ${runId}`]);
      return ok(statusLines(state));
    }),
  );

  // ---------------------------------------------------------------- bank_status

  server.registerTool(
    "bank_status",
    {
      title: "Purchase bank status",
      description:
        "Reports how many banked purchases are usable by a dispute step, with counts by status. Returns no ids.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guarded("bank_status", () => {
      const bank = readBank();
      const usable = availablePurchases(bank).length;
      const count = (status: string) => bank.purchases.filter((p) => p.status === status).length;
      return ok([
        `usable for a dispute step   ${usable}`,
        `awaiting approval           ${count("awaiting_approval")}`,
        `awaiting transaction id     ${count("awaiting_transaction_id")}`,
        `used                        ${count("used")}`,
        `expired                     ${count("expired")}`,
        ...(usable === 0 ? ["", `A dispute step ${NEEDS_BANKED_PURCHASE}.`] : []),
      ]);
    }),
  );

  // ---------------------------------------------------------------- find_edge_cases

  server.registerTool(
    "find_edge_cases",
    {
      title: "Find edge cases in the sample store",
      description:
        "Runs the edge-case finder against the configured sample store when confirm is true: per failure class, one model call fills a fixed scenario template, the run reuses the store's already registered webhook (never registers one), and the verdict comes, per class, from the store's verified rows for this run (duplicate-webhook, refund-after-partial) or from PayPal's own read-back of the record (unclaimed-payout, overdue-invoice). Without confirm, reports which classes would run and executes nothing.",
      inputSchema: {
        description: descriptionInput.optional(),
        only: classIdInput,
        confirm: confirmInput,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    guarded(
      "find_edge_cases",
      async ({ description, only, confirm }: { description?: string | undefined; only?: string | undefined; confirm?: boolean | undefined }) => {
        const classes = only === undefined ? FAILURE_CLASSES : FAILURE_CLASSES.filter((c) => c.id === only);
        if (classes.length === 0) {
          return refused([`REFUSED: no failure class with that id. Known: ${FAILURE_CLASSES.map((c) => c.id).join(", ")}.`]);
        }

        const { origins, caps } = config();
        const storeOrigin = assertAllowedEventTarget(requiredEnv("REHEARSAL_STORE_ORIGIN", deps.env), origins).origin;
        const storeToken = requiredEnv("REHEARSAL_STORE_TOKEN", deps.env);
        const usable = availablePurchases(readBank()).length;

        if (confirm !== true) {
          const lines = [
            "FINDER PREVIEW. Nothing ran: confirm was not true.",
            "  store           configured and on the allowlist",
            "  webhook mode    reuse-only: the store's registered webhook, never a new one",
            "",
          ];
          let runnable = 0;
          for (const cls of classes) {
            const why = !cls.supported
              ? `not reachable: ${cls.unsupportedReason ?? "unsupported"}`
              : cls.template === null
                ? "no fixed scenario"
                : cls.needsBankedPurchase && usable < 1
                  ? NEEDS_BANKED_PURCHASE
                  : null;
            if (why === null) runnable += 1;
            lines.push(`  ${cls.id.padEnd(28)} ${why === null ? "would run" : `skipped, ${why}`}`);
          }
          lines.push("", `${runnable} class(es) would run, each making 1 model call and creating sandbox records.`);
          return ok(lines);
        }

        const budget = aiBudget();
        const generate = generator();
        const seller = deps.makeClient("seller");
        const buyer = deps.makeClient("buyer");
        const slot = claimSlot();
        if (slot !== null) return refused([`REFUSED: ${slot}. Nothing ran.`]);
        try {
          const bank = bankStore(deps.paths);
          const results = await runFinder(
            {
              description: description ?? DEFAULT_FINDER_DESCRIPTION,
              only,
              webhookTarget: webhookHandlerUrl(storeOrigin),
            },
            finderDepsFrom({
              generate,
              budget,
              caps,
              allowedEventOrigins: origins,
              run: async (scenario, { webhookMode }) => {
                const runId = newRunId(deps.now());
                activeRunId = runId;
                return executeWithPersistence(
                  { scenario, runId, resume: null, webhookMode },
                  { paths: deps.paths, seller, buyer, now: deps.now, sleep: deps.sleep, log, env: deps.env },
                );
              },
              readStore: storeStateReader({
                origin: storeOrigin,
                token: storeToken,
                ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
              }),
              bankAvailable: () => availablePurchases(bank.read()).length,
              log,
              now: deps.now,
              sleep: deps.sleep,
            }),
          );

          const report = finderReportLines(results);
          const reportPath = resolve(deps.paths.runsDir, `finder-${newRunId(deps.now())}.md`);
          let reportLine = `report written to ${reportPath}`;
          try {
            mkdirSync(dirname(reportPath), { recursive: true });
            writeFileSync(reportPath, `${report.join("\n")}\n`, "utf8");
          } catch (e) {
            reportLine = `the report could not be written (${e instanceof Error ? e.name : "error"})`;
          }
          return ok([...report, "", reportLine, `model calls: ${budget.summary()}`]);
        } finally {
          busy = false;
          activeRunId = null;
        }
      },
    ),
  );

  return server;
}
