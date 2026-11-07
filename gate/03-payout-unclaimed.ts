import { credentialsFor } from "../src/adapters/env";
import { PaypalClient } from "../src/adapters/paypal";
import { seedOf, senderBatchId } from "../src/core/idempotency";
import { classify } from "../src/core/outcome";
import { unclaimedReceiver } from "./_fixtures";
import { errorSummary, pick, runGate, saveState, sleep } from "./_harness";

/**
 * Gate 3: a payout batch whose single recipient never claims it.
 *
 * UNCLAIMED is the interesting state for REHEARSAL: it is a real PayPal
 * condition a developer's code has to handle and cannot produce on demand today.
 * We get it by paying an address that has no PayPal account.
 */

const CURRENCY = "USD";
const AMOUNT = "5.00";
const POLL_BUDGET_MS = 90_000;
const POLL_INTERVAL_MS = 5000;

await runGate({
  id: "3",
  title: "payout batch with one unclaimed recipient",
  async run(ctx) {
    const client = new PaypalClient(credentialsFor("seller"), {
      label: "seller",
      log: ctx.log,
      minIntervalMs: 300,
    });

    const receiver = unclaimedReceiver(ctx.runId);
    const batchId = senderBatchId(seedOf(["gate3", "batch", ctx.runId]));
    ctx.log(`receiver ${receiver}`);
    ctx.record("sender_batch_id", batchId);

    const res = await client.call({
      method: "POST",
      path: "/v1/payments/payouts",
      idempotencySeed: seedOf(["gate3", "payout", ctx.runId]),
      body: {
        sender_batch_header: {
          sender_batch_id: batchId,
          email_subject: "REHEARSAL sandbox payout",
          email_message: "Sandbox payout created by REHEARSAL gate 3.",
        },
        items: [
          {
            recipient_type: "EMAIL",
            receiver,
            amount: { value: AMOUNT, currency: CURRENCY },
            note: "REHEARSAL gate 3 unclaimed recipient",
            sender_item_id: "gate3-item-1",
          },
        ],
      },
    });

    const payoutBatchId = pick(res.body, ["batch_header", "payout_batch_id"]);
    if (payoutBatchId !== null) ctx.record("payout_batch_id", payoutBatchId);
    if (res.debugId !== null) ctx.record("paypal_debug_id", res.debugId);

    const created = classify({
      httpStatus: res.status,
      body: { status: pick(res.body, ["batch_header", "batch_status"]) },
      expect: ["PENDING", "PROCESSING", "SUCCESS"],
      knownFailed: ["DENIED", "CANCELED"],
    });
    ctx.log(`batch creation verdict: ${created.kind} (${created.detail})`);

    if (created.kind !== "success" || payoutBatchId === null) {
      return {
        ok: false,
        reason: `payout batch not accepted: http ${res.status}, ${errorSummary(res.body, res.debugId)}`,
        ...(created.kind === "unknown" ? { qualifier: "UNKNOWN" } : {}),
      };
    }

    // Payouts settle asynchronously, so the item status needs polling.
    const deadline = Date.now() + POLL_BUDGET_MS;
    let batchStatus: string | null = null;
    let itemStatus: string | null = null;
    let payoutItemId: string | null = null;

    while (Date.now() < deadline) {
      const look = await client.call({
        method: "GET",
        path: `/v1/payments/payouts/${payoutBatchId}`,
      });
      batchStatus = pick(look.body, ["batch_header", "batch_status"]);
      itemStatus = pick(look.body, ["items", 0, "transaction_status"]);
      payoutItemId = pick(look.body, ["items", 0, "payout_item_id"]);
      ctx.log(`batch ${batchStatus ?? "?"} / item ${itemStatus ?? "?"}`);

      if (itemStatus !== null && itemStatus !== "PENDING") break;
      await sleep(POLL_INTERVAL_MS);
    }

    if (payoutItemId !== null) ctx.record("payout_item_id", payoutItemId);

    if (itemStatus === null) {
      return {
        ok: false,
        reason: `batch ${payoutBatchId} created but no item status was readable within ${POLL_BUDGET_MS / 1000}s`,
        qualifier: "UNKNOWN",
      };
    }
    if (itemStatus === "PENDING") {
      return {
        ok: false,
        reason: `item still PENDING after ${POLL_BUDGET_MS / 1000}s; UNCLAIMED not reached inside the budget`,
        qualifier: "AMBIGUOUS",
      };
    }
    if (itemStatus !== "UNCLAIMED") {
      return {
        ok: false,
        reason: `item settled as ${itemStatus}, not UNCLAIMED, so the unclaimed state was not produced`,
      };
    }

    saveState("gate3", { payoutBatchId, payoutItemId, receiver, amount: AMOUNT, currency: CURRENCY });

    return {
      ok: true,
      reason: `batch ${batchStatus ?? "?"} with one item UNCLAIMED (${CURRENCY} ${AMOUNT} to an address with no PayPal account)`,
    };
  },
});
