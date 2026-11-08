import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { AiBudgetTracker, aiBudgetFromEnv } from "../src/ai/budget";
import {
  DEFAULT_PLANNER_MODEL,
  anthropicGenerator,
  planScenario,
} from "../src/ai/planner";
import { MissingCredentialError, credentialsFor, optionalEnv, requiredEnv } from "../src/adapters/env";
import { type Caps, capsFromEnv } from "../src/core/caps";
import { PaypalClient } from "../src/adapters/paypal";
import {
  DEFAULT_FINDER_DESCRIPTION,
  bankStore as sharedBankStore,
  eventOriginsFromEnv,
  executeWithPersistence,
  finderDepsFrom,
  gateScenario,
  loadResume,
  newRunId,
  pathsUnder,
  storeStateReader,
} from "../src/app/runtime";
import { seedOf } from "../src/core/idempotency";
import { errorSummary, pick } from "../src/core/json";
import {
  addPurchase,
  attachTransactionId,
  availablePurchases,
  checkPurchaseAmount,
  confirmCapture,
  exportForHosted,
  hostedInsertSql,
  markExpired,
  matchBuyerTransaction,
} from "../src/core/purchaseBank";
import { assertAllowedEventTarget, webhookHandlerUrl } from "../src/core/eventTarget";
import { finderReportLines, runFinder } from "../src/ai/finder";
import type { RunState } from "../src/core/runState";
import { walletOrderBody } from "../src/core/sandboxFixtures";
import { type Scenario, validateScenario } from "../src/core/scenario";
import { dryRunLines } from "../src/executor/dryRun";
import type { WebhookMode } from "../src/executor/executor";
import { runReportLines } from "../src/executor/report";

/**
 * REHEARSAL command line. Deliberately thin: every decision it makes lives in a
 * tested module, and this file only wires them to the filesystem and the clock.
 */

const PATHS = pathsUnder(resolve("."));
const RUNS_DIR = PATHS.runsDir;
const THROTTLE_MS = 300;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const log = (line: string) => console.log(line);
const isoNoMillis = (d: Date) => `${d.toISOString().slice(0, 19)}Z`;

function args(rest: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < rest.length; i += 1) {
    const key = rest[i]!;
    if (!key.startsWith("--")) continue;
    const value = rest[i + 1];
    out[key.slice(2)] = value === undefined || value.startsWith("--") ? "true" : value;
    if (value !== undefined && !value.startsWith("--")) i += 1;
  }
  return out;
}

/** Origins a scenario may fire real events at. Empty means none are permitted. */
function allowedEventOrigins(): string[] {
  const parsed = eventOriginsFromEnv(process.env);
  if (!parsed.ok) {
    console.error(parsed.error);
    process.exit(1);
  }
  return parsed.origins;
}

function loadScenario(path: string | undefined): Scenario {
  if (path === undefined) {
    console.error("give me a scenario file, for example scenarios/candle-shop.json");
    process.exit(1);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(resolve(path), "utf8"));
  } catch (e) {
    console.error(`could not read ${path}: ${(e as Error).message}`);
    process.exit(1);
  }
  const result = validateScenario(parsed, { allowedEventOrigins: allowedEventOrigins() });
  if (!result.ok) {
    console.error(`${path} is not a valid scenario, so nothing will run:`);
    for (const e of result.errors) console.error(`  ${e}`);
    process.exit(1);
  }
  return result.scenario;
}

/** The caps, or a stop that names the variables. A malformed value is never echoed. */
function cliCaps(): Caps {
  try {
    return capsFromEnv(process.env);
  } catch {
    console.error(
      "a cap variable (REHEARSAL_MAX_STEP_AMOUNT, REHEARSAL_MAX_RUN_TOTAL, REHEARSAL_MAX_STEPS or REHEARSAL_MAX_DISPUTES) is malformed, so nothing will run. Fix it where your environment variables are set.",
    );
    process.exit(1);
  }
}

/**
 * A scenario file through the gate every MCP path runs: schema, allowlist and
 * caps. A hand-written file is no more trusted than a planned one. Shared by
 * dry-run and run, so a dry run never shows a plan that run would refuse, and
 * it is called before any client exists, so a refused run sends nothing.
 */
function loadCappedScenario(path: string | undefined, consequence: string): Scenario {
  const loaded = loadScenario(path);
  const gated = gateScenario(loaded, { allowedEventOrigins: allowedEventOrigins(), caps: cliCaps() });
  if (!gated.ok) {
    console.error(`${path} exceeds the spend caps, ${consequence}:`);
    for (const e of gated.errors) console.error(`  ${e}`);
    process.exit(1);
  }
  return gated.scenario;
}

function client(role: "seller" | "buyer") {
  return new PaypalClient(credentialsFor(role), {
    label: role,
    log,
    minIntervalMs: THROTTLE_MS,
  });
}

const bankStore = () => sharedBankStore(PATHS);

// ---------------------------------------------------------------- dry run

function dryRun(rest: string[]): void {
  const scenario = loadCappedScenario(rest[0], "so it would not run");
  for (const line of dryRunLines(scenario)) console.log(line);
}

// ---------------------------------------------------------------- plan

async function planCommand(rest: string[]): Promise<void> {
  const description = rest[0] !== undefined && !rest[0].startsWith("--") ? rest[0] : "";
  const flags = args(rest.slice(description === "" ? 0 : 1));

  if (description === "") {
    console.error('usage: rehearsal plan "<business description>" [--out <file>] [--yes]');
    process.exit(1);
  }

  const apiKey = requiredEnv("ANTHROPIC_API_KEY");
  const model = optionalEnv("REHEARSAL_PLANNER_MODEL") ?? DEFAULT_PLANNER_MODEL;
  const caps = cliCaps();
  const budget = new AiBudgetTracker(aiBudgetFromEnv(process.env));
  const origins = allowedEventOrigins();

  console.log(`planning with ${model}`);
  const outcome = await planScenario(
    { description, allowedEventOrigins: origins, caps },
    { generate: anthropicGenerator({ apiKey, model }), budget },
  );
  console.log(`model spend: ${budget.summary()}`);
  console.log("");

  if (!outcome.ok) {
    // Each of these is a refusal, not a crash. Nothing ran.
    switch (outcome.reason) {
      case "refused-by-model":
        console.error(`REFUSED by the model: ${outcome.detail}`);
        break;
      case "unparseable":
        console.error(`REFUSED: ${outcome.detail}`);
        break;
      case "schema-invalid":
        console.error("REFUSED: the plan does not pass the scenario schema, so it will not run:");
        for (const e of outcome.errors) console.error(`  ${e}`);
        break;
      case "over-caps":
        console.error("REFUSED: the plan exceeds the spend caps, so it will not run:");
        for (const v of outcome.violations) console.error(`  ${v.code}: ${v.message}`);
        break;
    }
    process.exitCode = 1;
    return;
  }

  for (const line of dryRunLines(outcome.scenario)) console.log(line);

  // Always saved. Planning is NOT deterministic (claude-sonnet-5 ignores
  // temperature), so "re-run the same command with --yes" would review one plan
  // and execute a different one. The file is the artifact you reviewed.
  const chosen = flags["out"];
  const outPath =
    chosen !== undefined && chosen !== "true"
      ? resolve(chosen)
      : resolve(RUNS_DIR, "plans", `plan-${isoNoMillis(new Date()).replace(/[:TZ-]/g, "")}.json`);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(outcome.scenario, null, 2)}\n`, "utf8");
  console.log("");
  console.log(`plan saved to ${outPath}`);

  if (flags["yes"] !== "true") {
    console.log("");
    console.log("Nothing has run. This plan came from an untrusted description, so read it,");
    console.log("then run the EXACT plan you just read:");
    console.log(`  npm run rehearsal -- run ${outPath}`);
    console.log("");
    console.log("Re-running `plan --yes` would ask the model again and could execute a");
    console.log("different plan from the one above.");
    return;
  }

  console.log("");
  console.log("--yes given: executing the plan printed above, from this same invocation.");
  console.log("No second model call is made, so what ran is what you just read.");
  await executeAndReport(outcome.scenario, {});
}

// ---------------------------------------------------------------- find

async function findCommand(rest: string[]): Promise<void> {
  const description =
    rest[0] !== undefined && !rest[0].startsWith("--") ? rest[0] : DEFAULT_FINDER_DESCRIPTION;
  const flags = args(rest.slice(rest[0] !== undefined && !rest[0].startsWith("--") ? 1 : 0));

  const apiKey = requiredEnv("ANTHROPIC_API_KEY");
  const model = optionalEnv("REHEARSAL_PLANNER_MODEL") ?? DEFAULT_PLANNER_MODEL;
  const storeOrigin = assertAllowedEventTarget(
    requiredEnv("REHEARSAL_STORE_ORIGIN"),
    allowedEventOrigins(),
  ).origin;
  const storeToken = requiredEnv("REHEARSAL_STORE_TOKEN");
  // Every finder run builds both clients; checked here so a missing key stops
  // the finder before its first model call rather than inside a run.
  credentialsFor("seller");
  credentialsFor("buyer");
  const caps = cliCaps();
  const budget = new AiBudgetTracker(aiBudgetFromEnv(process.env));
  const generate = anthropicGenerator({ apiKey, model });
  const bank = bankStore();

  console.log(`edge-case finder, planning with ${model}`);
  console.log(`sample store: ${storeOrigin}`);

  const results = await runFinder(
    { description, only: flags["only"], webhookTarget: webhookHandlerUrl(storeOrigin) },
    finderDepsFrom({
      generate,
      budget,
      caps,
      allowedEventOrigins: allowedEventOrigins(),
      run: (scenario, { webhookMode }) => executeScenarioFromCli(scenario, {}, webhookMode),
      readStore: storeStateReader({ origin: storeOrigin, token: storeToken }),
      bankAvailable: () => availablePurchases(bank.read()).length,
      log: (line) => console.log(line),
      now: () => new Date(),
      sleep,
    }),
  );

  const report = finderReportLines(results).join("\n");
  const reportPath = resolve(RUNS_DIR, `finder-${isoNoMillis(new Date()).replace(/[:TZ-]/g, "")}.md`);
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${report}\n`, "utf8");

  console.log("");
  console.log(report);
  console.log("");
  console.log(`report written to ${reportPath}`);
  console.log(`model spend: ${budget.summary()}`);

  // Non-zero when a bug was found, so the before and after of a fix is visible
  // in the exit code rather than only in prose.
  process.exitCode = results.some((r) => r.finding.verdict === "bug") ? 1 : 0;
}

// ---------------------------------------------------------------- run

async function run(rest: string[]): Promise<void> {
  const scenario = loadCappedScenario(rest[0], "so nothing was sent to PayPal");
  await executeAndReport(scenario, args(rest.slice(1)));
}

/** Shared by a file-based run and an AI-planned one, so both behave identically. */
async function executeAndReport(
  scenario: Scenario,
  flags: Record<string, string>,
): Promise<void> {
  const state = await executeScenarioFromCli(scenario, flags);

  const report = runReportLines(scenario, state).join("\n");
  const reportPath = resolve(RUNS_DIR, `${state.runId}.md`);
  writeFileSync(reportPath, `${report}\n`, "utf8");

  console.log("");
  console.log(report);
  console.log("");
  console.log(`report written to ${reportPath}`);
  process.exitCode = state.halted ? 1 : 0;
}

/**
 * Executes a scenario and hands back the run state. Separate from reporting so
 * the finder can read the state and draw its own conclusions.
 */
async function executeScenarioFromCli(
  scenario: Scenario,
  flags: Record<string, string> = {},
  webhookMode: WebhookMode = "register",
): Promise<RunState> {
  // Before a run id is printed, so a missing key leaves no half-started run
  // that looks resumable.
  const seller = client("seller");
  const buyer = client("buyer");
  const resumeId = flags["resume"];
  const runId = resumeId ?? newRunId(new Date());

  let resume: RunState | null = null;
  if (resumeId !== undefined) {
    let loaded;
    try {
      loaded = loadResume(RUNS_DIR, resumeId, flags["retry"] ?? null, new Date().toISOString());
    } catch (e) {
      console.error((e as Error).message);
      process.exit(1);
    }
    if (!loaded.ok) {
      console.error(loaded.error);
      if (loaded.halted) {
        console.error(
          "Check whether that step wrote to PayPal. If it definitely did not, re-run with --retry <stepId>.",
        );
      }
      process.exit(1);
    }
    resume = loaded.state;
    if (loaded.retried !== null) {
      console.log(
        `WARNING: retrying step ${loaded.retried}. Only do this when you have checked that it did NOT write to PayPal, because a retry can duplicate a payment.`,
      );
    }
  }

  console.log(`run ${runId}: ${scenario.name}`);
  return executeWithPersistence(
    { scenario, runId, resume, webhookMode },
    {
      paths: PATHS,
      seller,
      buyer,
      now: () => new Date(),
      sleep,
      log,
      env: process.env,
    },
  );
}

// ---------------------------------------------------------------- bank

async function bankAdd(rest: string[]): Promise<void> {
  const flags = args(rest);
  const amount = flags["amount"] ?? "88.00";
  const currency = flags["currency"] ?? "USD";
  // Checked before any client exists, so an over-cap purchase never reaches PayPal.
  const capped = checkPurchaseAmount(amount, currency, cliCaps());
  if (!capped.ok) {
    console.error(`${capped.error}, so no order was created`);
    process.exit(1);
  }
  const store = bankStore();

  const seller = client("seller");
  const reference = `bank-${randomBytes(3).toString("hex")}`;
  const res = await seller.call({
    method: "POST",
    path: "/v2/checkout/orders",
    idempotencySeed: seedOf(["bank", reference]),
    extraHeaders: { Prefer: "return=representation" },
    body: walletOrderBody(amount, currency, reference),
  });

  const orderId = pick(res.body, ["id"]);
  if (orderId === null) {
    console.error(`could not create the order: http ${res.status}, ${errorSummary(res.body, res.debugId)}`);
    process.exit(1);
  }

  const links = (res.body as { links?: Array<Record<string, unknown>> }).links ?? [];
  const approval = links.find((l) => l["rel"] === "payer-action" || l["rel"] === "approve");
  const approvalUrl = typeof approval?.["href"] === "string" ? approval["href"] : null;

  const added = addPurchase(store.read(), {
    id: reference,
    orderId,
    amount,
    currency,
    createdAt: new Date().toISOString(),
    approvalUrl,
  });
  if (!added.ok) {
    console.error(added.error);
    process.exit(1);
  }
  store.write(added.value);

  console.log("");
  console.log(`order        ${orderId}`);
  console.log(`amount       ${currency} ${amount}`);
  console.log(`status       ${pick(res.body, ["status"]) ?? "unreadable"}`);
  console.log("");
  if (approvalUrl === null) {
    console.log("no approval link came back, which means this order cannot be approved");
  } else {
    console.log("APPROVE THIS AS THE SANDBOX BUYER BUSINESS ACCOUNT:");
    console.log(`  ${approvalUrl}`);
    console.log("");
    console.log("Approve it promptly. The link is short lived: one left unapproved for about");
    console.log("12 hours returned 404 and had to be marked expired. PayPal does not publish");
    console.log("the exact lifetime, so treat it as minutes to hours, not a day.");
    console.log("");
    console.log("then run:  npm run bank:confirm");
  }
}

async function bankConfirm(): Promise<void> {
  const store = bankStore();
  const seller = client("seller");
  const buyer = client("buyer");

  let bank = store.read();
  const pendingApproval = bank.purchases.filter((p) => p.status === "awaiting_approval");
  const pendingTxn = bank.purchases.filter((p) => p.status === "awaiting_transaction_id");

  if (pendingApproval.length === 0 && pendingTxn.length === 0) {
    console.log("nothing to confirm: no purchase is awaiting approval or a transaction id");
    return;
  }

  for (const purchase of pendingApproval) {
    const look = await seller.call({
      method: "GET",
      path: `/v2/checkout/orders/${purchase.orderId}`,
    });
    // A 404 means PayPal no longer holds the order, so no amount of waiting will
    // make it approvable. Mark it dead rather than checking it forever.
    if (look.status === 404) {
      const expired = markExpired(
        bank,
        purchase.orderId,
        "PayPal returned 404 on the order, so it lapsed before anyone approved it",
      );
      if (expired.ok) {
        bank = expired.value;
        store.write(bank);
        console.log(
          `order ${purchase.orderId} EXPIRED: PayPal no longer has it (404), so it can never be approved. Run bank:add for a fresh one.`,
        );
      } else {
        console.log(`  ${expired.error}`);
      }
      continue;
    }

    const status = pick(look.body, ["status"]);
    console.log(`order ${purchase.orderId} reads ${status ?? "unreadable"}`);

    if (status === "CREATED" || status === "PAYER_ACTION_REQUIRED") {
      console.log(`  still needs approval: ${purchase.approvalUrl ?? "no link recorded"}`);
      continue;
    }

    let captureId = pick(look.body, ["purchase_units", 0, "payments", "captures", 0, "id"]);
    if (status === "APPROVED") {
      const cap = await seller.call({
        method: "POST",
        path: `/v2/checkout/orders/${purchase.orderId}/capture`,
        idempotencySeed: seedOf(["bank", "capture", purchase.orderId]),
        extraHeaders: { Prefer: "return=representation" },
      });
      captureId = pick(cap.body, ["purchase_units", 0, "payments", "captures", 0, "id"]);
      if (captureId === null) {
        console.log(`  capture failed: http ${cap.status}, ${errorSummary(cap.body, cap.debugId)}`);
        continue;
      }
      console.log(`  captured ${captureId}`);
    }

    if (captureId === null) {
      console.log("  no capture id available, leaving this purchase alone");
      continue;
    }
    const updated = confirmCapture(bank, purchase.orderId, captureId);
    if (!updated.ok) {
      console.log(`  ${updated.error}`);
      continue;
    }
    bank = updated.value;
    store.write(bank);
  }

  // Look up buyer-side transaction ids. Transaction Search is documented to lag
  // by up to three hours, so a miss is reported rather than retried forever.
  const stillWaiting = bank.purchases.filter((p) => p.status === "awaiting_transaction_id");
  if (stillWaiting.length > 0) {
    const end = new Date();
    const start = new Date(end.getTime() - 48 * 60 * 60 * 1000);
    const path = `/v1/reporting/transactions?start_date=${encodeURIComponent(isoNoMillis(start))}&end_date=${encodeURIComponent(isoNoMillis(end))}&fields=transaction_info&page_size=100`;
    const res = await buyer.call({ method: "GET", path });

    if (res.status !== 200) {
      console.log("");
      console.log(
        `buyer transaction search returned http ${res.status}: ${errorSummary(res.body, res.debugId)}`,
      );
      console.log("Enable Transaction Search on the rehearsal-buyer app, or supply ids by hand.");
    } else {
      const holder = res.body as { transaction_details?: unknown };
      const rows = Array.isArray(holder.transaction_details) ? holder.transaction_details : [];
      const alreadyBanked = new Set(
        bank.purchases.map((p) => p.buyerTransactionId).filter((v): v is string => v !== null),
      );

      for (const purchase of stillWaiting) {
        const waiting = bank.purchases.filter((p) => p.status === "awaiting_transaction_id");
        const match = matchBuyerTransaction(purchase, rows, alreadyBanked, waiting);

        if (match.id === null) {
          console.log(
            `order ${purchase.orderId}: no buyer transaction matching ${purchase.currency} ${purchase.amount} is visible yet. Transaction Search can lag up to three hours; run bank:confirm again later.`,
          );
          continue;
        }
        if (match.candidates > 1) {
          console.log(
            `order ${purchase.orderId}: ${match.candidates} transactions match that amount and currency, taking the one closest to the order's creation (${match.id})`,
          );
        }
        const attached = attachTransactionId(bank, purchase.orderId, match.id);
        if (!attached.ok) {
          console.log(`  ${attached.error}`);
          continue;
        }
        alreadyBanked.add(match.id);
        bank = attached.value;
        store.write(bank);
        console.log(`order ${purchase.orderId}: buyer transaction ${match.id} recorded, now available`);
      }
    }
  }

  bankList();
}

/**
 * Supplies a buyer-side transaction id by hand. Needed for two reasons that are
 * both outside our control: the buyer app may lack a reporting scope, and
 * PayPal documents Transaction Search as lagging up to three hours even when it
 * is enabled.
 */
function bankSetTxn(rest: string[]): void {
  const flags = args(rest);
  const orderId = flags["order"];
  const txn = flags["txn"];
  if (orderId === undefined || txn === undefined) {
    console.error("usage: rehearsal bank:set-txn --order <orderId> --txn <buyerTransactionId>");
    console.error("Read the transaction id from the sandbox BUYER account's activity page.");
    process.exit(1);
  }
  const store = bankStore();
  const result = attachTransactionId(store.read(), orderId, txn);
  if (!result.ok) {
    console.error(result.error);
    process.exit(1);
  }
  store.write(result.value);
  console.log(`order ${orderId}: buyer transaction ${txn} recorded by hand, now available`);
  bankList();
}

/**
 * Moves ready purchases to the hosted console's bank (Stage B). Writes a SQL
 * file to paste into the CONSOLE's Supabase SQL editor, rather than calling
 * that database, so its service key never has to live on this machine. The
 * local bank is written first, with the moved purchases marked used: if the
 * file is never run they are burned, but they can never be disputed from both
 * banks.
 */
function bankExportHosted(rest: string[]): void {
  const flags = args(rest);
  const raw = flags["count"] ?? "1";
  if (!/^\d+$/.test(raw)) {
    console.error("usage: rehearsal bank:export-hosted [--count 1] [--out bank/hosted-<time>.sql]");
    process.exit(1);
  }
  const nowIso = new Date().toISOString();
  const store = bankStore();
  const moved = exportForHosted(store.read(), Number(raw), nowIso);
  if (!moved.ok) {
    console.error(moved.error);
    process.exit(1);
  }
  const sql = hostedInsertSql(moved.value.moved, nowIso);
  if (!sql.ok) {
    console.error(`${sql.error}; nothing was moved`);
    process.exit(1);
  }
  const out = resolve(flags["out"] ?? `bank/hosted-${nowIso.replace(/[:.]/g, "-")}.sql`);
  store.write(moved.value.bank);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, sql.value, "utf8");
  for (const p of moved.value.moved) console.log(`moved order ${p.orderId} (${p.currency} ${p.amount}); marked used here`);
  console.log(`SQL written to ${out}`);
  console.log("Next: paste it into the SQL editor of the CONSOLE's Supabase project and run it. Its last line prints the hosted bank's counts.");
  bankList();
}

function bankList(): void {
  const bank = bankStore().read();
  console.log("");
  if (bank.purchases.length === 0) {
    console.log("the purchase bank is empty");
    return;
  }
  console.log("purchase bank:");
  for (const p of bank.purchases) {
    console.log(
      `  ${p.status.padEnd(24)} ${p.currency} ${p.amount.padEnd(8)} order ${p.orderId}` +
        `${p.buyerTransactionId === null ? "" : ` txn ${p.buyerTransactionId}`}` +
        `${p.usedByRunId === null ? "" : ` used by ${p.usedByRunId}`}`,
    );
  }
  const ready = bank.purchases.filter((p) => p.status === "available").length;
  console.log(`  ${ready} available for a dispute step`);
}

// ---------------------------------------------------------------- entry

function usage(): void {
  console.log("REHEARSAL");
  console.log("  rehearsal dry-run <scenario.json>        print the plan, no network calls");
  console.log('  rehearsal plan "<description>" [--out <file>]   AI-plan a scenario, save it, run nothing');
  console.log('  rehearsal plan "<description>" --yes     plan it and then run it');
  console.log("  rehearsal run <scenario.json>            run it against the sandbox");
  console.log("  rehearsal run <scenario.json> --resume <runId> [--retry <stepId>]");
  console.log('  rehearsal find ["<description>"] [--only <classId>]   run the edge-case finder against the sample store');
  console.log("  rehearsal bank:add [--amount 88.00]      create an order and print its approval link");
  console.log("  rehearsal bank:confirm                   capture approved orders and find buyer txn ids");
  console.log("  rehearsal bank:set-txn --order <id> --txn <id>   supply a buyer txn id by hand");
  console.log("  rehearsal bank:list                      show the purchase bank");
  console.log("  rehearsal bank:export-hosted [--count 1] move ready purchases to the console's bank, as SQL");
}

const [, , command, ...rest] = process.argv;

try {
  await dispatch();
} catch (e) {
  // A missing key is a setup step, not a crash: name it (never its value) on
  // one line, with an exit code a script can tell apart from a halted run's 1.
  if (!(e instanceof MissingCredentialError)) throw e;
  console.error(`${e.variableName} is not set, so nothing was sent to PayPal. Set it in your environment and run the command again.`);
  process.exitCode = 2;
}

async function dispatch(): Promise<void> {
  switch (command) {
    case "dry-run":
      dryRun(rest);
      break;
    case "plan":
      await planCommand(rest);
      break;
    case "find":
      await findCommand(rest);
      break;
    case "run":
      await run(rest);
      break;
    case "bank:add":
      await bankAdd(rest);
      break;
    case "bank:confirm":
      await bankConfirm();
      break;
    case "bank:set-txn":
      bankSetTxn(rest);
      break;
    case "bank:list":
      bankList();
      break;
    case "bank:export-hosted":
      bankExportHosted(rest);
      break;
    default:
      usage();
      process.exitCode = command === undefined ? 0 : 1;
  }
}
