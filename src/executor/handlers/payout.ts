import { errorSummary, pick } from "../../core/json";
import { senderBatchId } from "../../core/idempotency";
import { classify } from "../../core/outcome";
import { unclaimedReceiver } from "../../core/sandboxFixtures";
import { type StepHandler, failed, succeeded, unknown, wrongKind } from "../types";

/**
 * Opens the detail of a payout that PayPal settled into the wrong state. The
 * finder calls a payout a bug only on this, read back from PayPal, never on a
 * refusal or an unknown outcome, so the wording is shared rather than copied.
 */
export const ITEM_STATUS_MISMATCH = "item status mismatch";

const POLL_BUDGET_MS = 90_000;
const POLL_INTERVAL_MS = 5000;
/** Bounds the loop independently of the clock, so a stalled clock cannot hang a run. */
const MAX_POLLS = Math.ceil(POLL_BUDGET_MS / POLL_INTERVAL_MS) + 2;

/**
 * A payout batch, optionally with recipients who never claim it. UNCLAIMED is the
 * interesting state: a real PayPal condition a developer's code must handle and
 * cannot produce on demand today. Gate 3 proved the reserved-address route.
 */
export const payoutBatchHandler: StepHandler = async (ctx) => {
  const step = ctx.step;
  if (step.kind !== "payout_batch") return wrongKind("payout_batch", step.kind);

  const currency = ctx.scenario.currency;
  const claimedReceiver = ctx.env["REHEARSAL_PAYOUT_RECEIVER"];

  const items: Array<Record<string, unknown>> = [];
  step.items.forEach((item, i) => {
    const receiver = item.unclaimed
      ? unclaimedReceiver(`${ctx.seed}${i}`)
      : (claimedReceiver ?? "");
    items.push({
      recipient_type: "EMAIL",
      receiver,
      amount: { value: item.amount, currency },
      note: item.note ?? `REHEARSAL ${step.id} item ${i + 1}`,
      sender_item_id: `${step.id}-${i + 1}`.slice(0, 30),
    });
  });

  // Fail closed rather than quietly paying a reserved address when the scenario
  // asked for a recipient who would actually receive the money.
  const needsRealReceiver = step.items.some((i) => !i.unclaimed);
  if (needsRealReceiver && (claimedReceiver === undefined || claimedReceiver.trim() === "")) {
    return failed(
      "this batch asks for a claimed payout, which needs a real sandbox recipient in REHEARSAL_PAYOUT_RECEIVER",
    );
  }

  const batchId = senderBatchId(ctx.seed);
  const ids: Record<string, string> = { sender_batch_id: batchId };

  const res = await ctx.seller.call({
    method: "POST",
    path: "/v1/payments/payouts",
    idempotencySeed: ctx.seed,
    body: {
      sender_batch_header: {
        sender_batch_id: batchId,
        email_subject: "REHEARSAL sandbox payout",
        email_message: `Sandbox payout from REHEARSAL step ${step.id}.`,
      },
      items,
    },
  });

  const payoutBatchId = pick(res.body, ["batch_header", "payout_batch_id"]);
  if (payoutBatchId !== null) ids["payout_batch_id"] = payoutBatchId;

  const created = classify({
    httpStatus: res.status,
    body: { status: pick(res.body, ["batch_header", "batch_status"]) },
    expect: ["PENDING", "PROCESSING", "SUCCESS"],
    knownFailed: ["DENIED", "CANCELED"],
  });
  if (created.kind !== "success" || payoutBatchId === null) {
    const detail = `payout batch not accepted: http ${res.status}, ${errorSummary(res.body, res.debugId)}`;
    return created.kind === "failed" ? failed(detail, ids) : unknown(detail, ids);
  }

  // Payouts settle asynchronously, so item status needs polling.
  const deadline = ctx.now().getTime() + POLL_BUDGET_MS;
  let itemStatuses: Array<string | null> = [];
  let batchStatus: string | null = null;

  for (let poll = 0; poll < MAX_POLLS && ctx.now().getTime() < deadline; poll += 1) {
    const look = await ctx.seller.call({
      method: "GET",
      path: `/v1/payments/payouts/${payoutBatchId}`,
    });
    batchStatus = pick(look.body, ["batch_header", "batch_status"]);
    itemStatuses = step.items.map((_, i) => pick(look.body, ["items", i, "transaction_status"]));
    step.items.forEach((_, i) => {
      const itemId = pick(look.body, ["items", i, "payout_item_id"]);
      if (itemId !== null) ids[`payout_item_${i + 1}`] = itemId;
    });
    ctx.log(`batch ${batchStatus ?? "?"} items [${itemStatuses.map((s) => s ?? "?").join(", ")}]`);

    if (itemStatuses.every((s) => s !== null && s !== "PENDING")) break;
    await ctx.sleep(POLL_INTERVAL_MS);
  }

  if (itemStatuses.some((s) => s === null)) {
    return unknown(`batch ${payoutBatchId} created but an item status was unreadable`, ids);
  }
  if (itemStatuses.some((s) => s === "PENDING")) {
    return unknown(
      `batch ${payoutBatchId} still has PENDING items after ${POLL_BUDGET_MS / 1000}s`,
      ids,
    );
  }

  const mismatches = step.items
    .map((item, i) => ({ i, want: item.unclaimed ? "UNCLAIMED" : "SUCCESS", got: itemStatuses[i] }))
    .filter((m) => m.got !== m.want);

  if (mismatches.length > 0) {
    return failed(
      `${ITEM_STATUS_MISMATCH}: ${mismatches.map((m) => `item ${m.i + 1} is ${m.got}, expected ${m.want}`).join("; ")}`,
      ids,
    );
  }

  return succeeded(
    `batch ${batchStatus ?? "?"} with ${step.items.length} item(s): ${itemStatuses.join(", ")}`,
    ids,
  );
};
