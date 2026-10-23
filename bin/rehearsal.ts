import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { AiBudgetTracker, aiBudgetFromEnv } from "../src/ai/budget";
import {
  DEFAULT_PLANNER_MODEL,
  anthropicGenerator,
  planScenario,
} from "../src/ai/planner";
import { credentialsFor, optionalEnv, requiredEnv } from "../src/adapters/env";
import { capsFromEnv } from "../src/core/caps";
import { JsonStore } from "../src/adapters/jsonStore";
import { PaypalClient } from "../src/adapters/paypal";
import { seedOf } from "../src/core/idempotency";
import { errorSummary, pick } from "../src/core/json";
import {
  type Bank,
  addPurchase,
  attachTransactionId,
  claimPurchase,
  confirmCapture,
  emptyBank,
  markExpired,
} from "../src/core/purchaseBank";
import { type RunState, retryStep } from "../src/core/runState";
import { walletOrderBody } from "../src/core/sandboxFixtures";
import { type Scenario, validateScenario } from "../src/core/scenario";
import { dryRunLines } from "../src/executor/dryRun";
import { executeScenario } from "../src/executor/executor";
import { runReportLines } from "../src/executor/report";
import type { ClaimResult } from "../src/executor/types";

/**
 * REHEARSAL command line. Deliberately thin: every decision it makes lives in a
 * tested module, and this file only wires them to the filesystem and the clock.
 */

const BANK_PATH = resolve("bank/purchases.json");
const RUNS_DIR = resolve("runs");
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
  const raw = [optionalEnv("REHEARSAL_EVENT_ORIGINS"), optionalEnv("REHEARSAL_RECEIVER_ORIGIN")]
    .filter((v): v is string => v !== null)
    .flatMap((v) => v.split(","))
    .map((v) => v.trim())
    .filter((v) => v !== "");
  return [...new Set(raw)];
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

function client(role: "seller" | "buyer") {
  return new PaypalClient(credentialsFor(role), {
    label: role,
    log,
    minIntervalMs: THROTTLE_MS,
  });
}

const bankStore = () => new JsonStore<Bank>(BANK_PATH, emptyBank);

// ---------------------------------------------------------------- dry run

function dryRun(rest: string[]): void {
  const scenario = loadScenario(rest[0]);
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
  const caps = capsFromEnv(process.env);
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

// ---------------------------------------------------------------- run

async function run(rest: string[]): Promise<void> {
  const scenario = loadScenario(rest[0]);
  await executeAndReport(scenario, args(rest.slice(1)));
}

/** Shared by a file-based run and an AI-planned one, so both behave identically. */
async function executeAndReport(
  scenario: Scenario,
  flags: Record<string, string>,
): Promise<void> {
  const resumeId = flags["resume"];
  const runId =
    resumeId ??
    `${isoNoMillis(new Date()).replace(/[:TZ-]/g, "")}-${randomBytes(3).toString("hex")}`;
  const stateStore = new JsonStore<RunState | null>(
    resolve(RUNS_DIR, `${runId}.json`),
    () => null,
  );

  let resume: RunState | null = null;
  if (resumeId !== undefined) {
    resume = stateStore.read();
    if (resume === null) {
      console.error(`no run state found for ${resumeId}, so there is nothing to resume`);
      process.exit(1);
    }
    const retryId = flags["retry"];
    if (retryId !== undefined) {
      const reset = retryStep(resume, retryId, new Date().toISOString());
      if (!reset.ok) {
        console.error(reset.error);
        process.exit(1);
      }
      resume = reset.state;
      console.log(
        `WARNING: retrying step ${retryId}. Only do this when you have checked that it did NOT write to PayPal, because a retry can duplicate a payment.`,
      );
    } else if (resume.halted) {
      console.error(`run ${resumeId} is halted: ${resume.haltReason ?? "no reason recorded"}`);
      console.error(
        "Check whether that step wrote to PayPal. If it definitely did not, re-run with --retry <stepId>.",
      );
      process.exit(1);
    }
  }

  const bank = bankStore();
  const claim = (rid: string): ClaimResult => {
    const current = bank.read();
    const result = claimPurchase(current, rid, new Date().toISOString());
    if (!result.ok) return { ok: false, error: result.error };
    // Written BEFORE the dispute call. A crash between the two burns one banked
    // purchase, which costs a human click; reusing one would double-dispute a
    // transaction, which is worse.
    bank.write(result.value.bank);
    log(
      `purchase ${result.value.claimed.orderId} claimed and marked used, whatever the dispute call returns`,
    );
    return { ok: true, purchase: result.value.claimed };
  };

  console.log(`run ${runId}: ${scenario.name}`);
  const state = await executeScenario(
    { scenario, runId, resume },
    {
      seller: client("seller"),
      buyer: client("buyer"),
      claimPurchase: claim,
      persist: (s) => stateStore.write(s),
      now: () => new Date(),
      sleep,
      log,
      env: process.env,
    },
  );

  const report = runReportLines(scenario, state).join("\n");
  const reportPath = resolve(RUNS_DIR, `${runId}.md`);
  writeFileSync(reportPath, `${report}\n`, "utf8");

  console.log("");
  console.log(report);
  console.log("");
  console.log(`report written to ${reportPath}`);
  process.exitCode = state.halted ? 1 : 0;
}

// ---------------------------------------------------------------- bank

async function bankAdd(rest: string[]): Promise<void> {
  const flags = args(rest);
  const amount = flags["amount"] ?? "88.00";
  const currency = flags["currency"] ?? "USD";
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
    console.error(`could not create the order: http ${res.status}, ${errorSummary(res.body, res.bodyPreview)}`);
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
        console.log(`  capture failed: http ${cap.status}, ${errorSummary(cap.body, cap.bodyPreview)}`);
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
        `buyer transaction search returned http ${res.status}: ${errorSummary(res.body, res.bodyPreview)}`,
      );
      console.log("Enable Transaction Search on the rehearsal-buyer app, or supply ids by hand.");
    } else {
      const holder = res.body as { transaction_details?: unknown };
      const rows = Array.isArray(holder.transaction_details) ? holder.transaction_details : [];
      const alreadyBanked = new Set(
        bank.purchases.map((p) => p.buyerTransactionId).filter((v): v is string => v !== null),
      );

      for (const purchase of stillWaiting) {
        const candidates = rows
          .map((r) => (r as Record<string, unknown>)["transaction_info"])
          .map((info) => ({
            id: pick(info, ["transaction_id"]),
            value: pick(info, ["transaction_amount", "value"]),
            at: pick(info, ["transaction_initiation_date"]) ?? "",
          }))
          .filter(
            (c) =>
              c.id !== null &&
              c.value !== null &&
              c.value.replace("-", "") === purchase.amount &&
              !alreadyBanked.has(c.id),
          )
          .sort((a, b) => b.at.localeCompare(a.at));

        if (candidates.length === 0) {
          console.log(
            `order ${purchase.orderId}: no buyer transaction matching ${purchase.currency} ${purchase.amount} is visible yet. Transaction Search can lag up to three hours; run bank:confirm again later.`,
          );
          continue;
        }
        const chosen = candidates[0]!;
        if (candidates.length > 1) {
          console.log(
            `order ${purchase.orderId}: ${candidates.length} transactions match that amount, taking the most recent (${chosen.id})`,
          );
        }
        const attached = attachTransactionId(bank, purchase.orderId, chosen.id!);
        if (!attached.ok) {
          console.log(`  ${attached.error}`);
          continue;
        }
        alreadyBanked.add(chosen.id!);
        bank = attached.value;
        store.write(bank);
        console.log(`order ${purchase.orderId}: buyer transaction ${chosen.id} recorded, now available`);
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
  console.log('  rehearsal plan "<description>"           AI-plan a scenario, shows it only');
  console.log('  rehearsal plan "<description>" --yes     plan it and then run it');
  console.log("  rehearsal run <scenario.json>            run it against the sandbox");
  console.log("  rehearsal run <scenario.json> --resume <runId> [--retry <stepId>]");
  console.log("  rehearsal bank:add [--amount 88.00]      create an order and print its approval link");
  console.log("  rehearsal bank:confirm                   capture approved orders and find buyer txn ids");
  console.log("  rehearsal bank:set-txn --order <id> --txn <id>   supply a buyer txn id by hand");
  console.log("  rehearsal bank:list                      show the purchase bank");
}

const [, , command, ...rest] = process.argv;

switch (command) {
  case "dry-run":
    dryRun(rest);
    break;
  case "plan":
    await planCommand(rest);
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
  default:
    usage();
    process.exitCode = command === undefined ? 0 : 1;
}
