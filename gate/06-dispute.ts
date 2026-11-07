import { credentialsFor, optionalEnv } from "../src/adapters/env";
import { PaypalClient } from "../src/adapters/paypal";
import { seedOf } from "../src/core/idempotency";
import { classify } from "../src/core/outcome";
import { selfLinkId } from "../src/core/paypalLinks";
import { CURRENCY } from "./_fixtures";
import { clearState, errorSummary, loadState, pick, runGate, saveState, sleep } from "./_harness";

/**
 * Gate 6: a real buyer-side dispute, moved and settled by our code.
 *
 * Two things make this the hardest gate. A PayPal-wallet payment needs the buyer
 * to approve in a browser, which is the one human step in the whole suite. And
 * sandbox dispute creation is not in PayPal's public OpenAPI spec at all, so
 * whether the buyer app can create one is a question this gate answers by
 * trying it and reporting exactly what comes back.
 *
 * The gate is resumable on purpose. Run it once and it creates the order and
 * prints the approval link. Brian clicks once. Run it again and it captures,
 * files the dispute from the buyer app, then moves it with require-evidence and
 * settles it with adjudicate from the seller app.
 */

const AMOUNT = "88.00";
const DISPUTE_REASON = "MERCHANDISE_OR_SERVICE_NOT_RECEIVED";
const DISPUTE_POLL_BUDGET_MS = 120_000;
const TXN_SEARCH_ATTEMPTS = 3;
const TXN_SEARCH_INTERVAL_MS = 15_000;

type Gate6State = {
  orderId: string;
  captureId?: string;
  disputeId?: string;
};

function approvalLink(body: unknown): string | null {
  const holder = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  const links = Array.isArray(holder["links"]) ? holder["links"] : [];
  for (const l of links) {
    if (typeof l === "object" && l !== null) {
      const rec = l as Record<string, unknown>;
      if ((rec["rel"] === "payer-action" || rec["rel"] === "approve") && typeof rec["href"] === "string") {
        return rec["href"];
      }
    }
  }
  return null;
}

type TxnLookup = { id: string | null; how: string; detail: string };

/**
 * The dispute body needs the BUYER-side transaction id, which is a different id
 * from the seller's capture id for the same money movement. The buyer's own
 * token is the only thing that can see it.
 *
 * Transaction Search is documented to lag by up to three hours, so this polls a
 * little and then gives up honestly rather than looping.
 */
async function findBuyerTransactionId(
  buyer: PaypalClient,
  ctx: { log: (line: string) => void },
  amount: string,
): Promise<TxnLookup> {
  const override = optionalEnv("REHEARSAL_BUYER_TRANSACTION_ID");
  if (override !== null) {
    return { id: override, how: "supplied via REHEARSAL_BUYER_TRANSACTION_ID", detail: "" };
  }

  const fmt = (d: Date) => `${d.toISOString().slice(0, 19)}-0000`;
  let lastDetail = "transaction search never ran";

  for (let attempt = 1; attempt <= TXN_SEARCH_ATTEMPTS; attempt += 1) {
    const end = new Date();
    const start = new Date(end.getTime() - 48 * 60 * 60 * 1000);
    const res = await buyer.call({
      method: "GET",
      path: `/v1/reporting/transactions?start_date=${encodeURIComponent(fmt(start))}&end_date=${encodeURIComponent(fmt(end))}&fields=transaction_info&page_size=100`,
    });

    if (res.status !== 200) {
      lastDetail = `buyer transaction search returned http ${res.status}: ${errorSummary(res.body, res.debugId)}`;
      ctx.log(lastDetail);
      // Missing permission will not fix itself by waiting.
      if (res.status === 401 || res.status === 403) {
        return { id: null, how: "", detail: lastDetail };
      }
    } else {
      const holder = res.body as { transaction_details?: unknown };
      const details = Array.isArray(holder.transaction_details) ? holder.transaction_details : [];
      const matches: Array<{ id: string; at: string }> = [];
      for (const d of details) {
        const info = (d as Record<string, unknown>)["transaction_info"];
        const id = pick(info, ["transaction_id"]);
        const value = pick(info, ["transaction_amount", "value"]);
        // The buyer side records the amount as a debit, so compare magnitudes.
        if (id !== null && value !== null && value.replace("-", "") === amount) {
          matches.push({ id, at: pick(info, ["transaction_initiation_date"]) ?? "" });
        }
      }
      lastDetail = `buyer transaction search saw ${details.length} transaction(s), ${matches.length} matching ${amount}`;
      ctx.log(lastDetail);
      if (matches.length > 0) {
        matches.sort((a, b) => b.at.localeCompare(a.at));
        return {
          id: matches[0]!.id,
          how: "found by buyer-side transaction search",
          detail: lastDetail,
        };
      }
    }
    if (attempt < TXN_SEARCH_ATTEMPTS) await sleep(TXN_SEARCH_INTERVAL_MS);
  }
  return { id: null, how: "", detail: lastDetail };
}

await runGate({
  id: "6",
  title: "buyer-side dispute, moved with require-evidence and settled with adjudicate",
  async run(ctx) {
    const seller = new PaypalClient(credentialsFor("seller"), {
      label: "seller",
      log: ctx.log,
      minIntervalMs: 300,
    });
    const buyer = new PaypalClient(credentialsFor("buyer"), {
      label: "buyer",
      log: ctx.log,
      minIntervalMs: 300,
    });

    // An order tied to the wrong buyer account can never be approved, so there
    // has to be a way to abandon it rather than resume it forever.
    if (process.argv.includes("--fresh")) {
      clearState("gate6");
      ctx.note("--fresh: discarded any previously saved gate 6 order");
    }

    const saved = loadState<Gate6State>("gate6");

    // Phase A: no order yet. Create one the buyer account can approve.
    if (saved === null) {
      const res = await seller.call({
        method: "POST",
        path: "/v2/checkout/orders",
        idempotencySeed: seedOf(["gate6", "order", ctx.runId]),
        extraHeaders: { Prefer: "return=representation" },
        body: {
          intent: "CAPTURE",
          purchase_units: [
            {
              reference_id: "rehearsal-gate-6",
              description: "REHEARSAL gate 6, item that will not arrive",
              amount: { currency_code: CURRENCY, value: AMOUNT },
            },
          ],
          payment_source: {
            paypal: {
              experience_context: {
                return_url: "https://example.com/rehearsal/return",
                cancel_url: "https://example.com/rehearsal/cancel",
                user_action: "PAY_NOW",
              },
            },
          },
        },
      });

      const orderId = pick(res.body, ["id"]);
      if (orderId !== null) ctx.record("order_id", orderId);
      if (orderId === null) {
        return {
          ok: false,
          reason: `could not create the wallet order: http ${res.status}, ${errorSummary(res.body, res.debugId)}`,
        };
      }
      saveState("gate6", { orderId });

      const link = approvalLink(res.body);
      ctx.note(`order status is ${pick(res.body, ["status"]) ?? "unreadable"}`);
      if (link !== null) ctx.note(`APPROVAL URL: ${link}`);

      return {
        ok: false,
        reason:
          link === null
            ? `order ${orderId} created but no approval link was returned, so the buyer cannot approve`
            : `order ${orderId} needs one browser approval. Open the APPROVAL URL above, log in as the sandbox BUYER business account, approve, then run gate 6 again.`,
        qualifier: "BLOCKED",
      };
    }

    // Phase B: an order exists. Where is it?
    ctx.record("order_id (resumed)", saved.orderId);
    if (saved.captureId !== undefined) ctx.record("capture_id (resumed)", saved.captureId);
    const look = await seller.call({ method: "GET", path: `/v2/checkout/orders/${saved.orderId}` });
    const orderStatus = pick(look.body, ["status"]);
    ctx.log(`order ${saved.orderId} reads ${orderStatus ?? "unreadable"}`);

    let captureId = saved.captureId ?? null;

    if (orderStatus === "CREATED" || orderStatus === "PAYER_ACTION_REQUIRED") {
      const link = approvalLink(look.body);
      if (link !== null) ctx.note(`APPROVAL URL: ${link}`);
      return {
        ok: false,
        reason: `order ${saved.orderId} is still ${orderStatus} and has not been approved yet. Open the APPROVAL URL above as the sandbox buyer, approve, then run gate 6 again.`,
        qualifier: "BLOCKED",
      };
    }

    if (orderStatus === "APPROVED") {
      const cap = await seller.call({
        method: "POST",
        path: `/v2/checkout/orders/${saved.orderId}/capture`,
        idempotencySeed: seedOf(["gate6", "capture", saved.orderId]),
        extraHeaders: { Prefer: "return=representation" },
      });
      const capVerdict = classify({
        httpStatus: cap.status,
        body: cap.body,
        expect: ["COMPLETED"],
        knownFailed: ["VOIDED"],
      });
      captureId = pick(cap.body, ["purchase_units", 0, "payments", "captures", 0, "id"]);
      if (captureId !== null) ctx.record("capture_id", captureId);
      ctx.log(`capture verdict: ${capVerdict.kind} (${capVerdict.detail})`);
      if (capVerdict.kind !== "success" || captureId === null) {
        return {
          ok: false,
          reason: `capture of approved order failed: http ${cap.status}, ${errorSummary(cap.body, cap.debugId)}`,
          ...(capVerdict.kind === "unknown" ? { qualifier: "UNKNOWN" } : {}),
        };
      }
      saveState("gate6", { ...saved, captureId });
    } else if (orderStatus === "COMPLETED" && captureId === null) {
      captureId = pick(look.body, ["purchase_units", 0, "payments", "captures", 0, "id"]);
      if (captureId !== null) {
        ctx.record("capture_id", captureId);
        saveState("gate6", { ...saved, captureId });
      }
    }

    if (captureId === null) {
      return {
        ok: false,
        reason: `order ${saved.orderId} is ${orderStatus ?? "unreadable"} and no capture id could be found, so there is no transaction to dispute`,
        qualifier: "UNKNOWN",
      };
    }

    // Phase C: file the dispute from the BUYER app. No PayPal-Auth-Assertion:
    // the buyer business account acts for itself, which is the only path the
    // recon found working.
    let disputeId = saved.disputeId ?? null;

    if (disputeId === null) {
      const found = await findBuyerTransactionId(buyer, ctx, AMOUNT);
      if (found.id === null) {
        const hasReporting =
          buyer.tokenMeta?.scopes.some((s) => s.includes("reporting")) === true;
        return {
          ok: false,
          reason: `could not read the buyer-side transaction id by API (${found.detail}). Buyer app ${hasReporting ? "has" : "does NOT have"} a reporting scope, and PayPal documents Transaction Search as lagging by up to three hours. Read the transaction id from the buyer account's activity page, set REHEARSAL_BUYER_TRANSACTION_ID, then run gate 6 again. Capture ${captureId} is already settled, so nothing needs redoing.`,
          qualifier: "BLOCKED",
        };
      }
      ctx.record("buyer_transaction_id", found.id);
      ctx.log(`buyer transaction id ${found.how}`);

      // Shape confirmed by another hackathon entrant in PayPal's Discord, and it
      // is NOT in the public OpenAPI spec. Note buyer_transaction_id, not the
      // seller's capture id, and no PayPal-Auth-Assertion header.
      const filed = await buyer.call({
        method: "POST",
        path: "/v1/customer/disputes",
        idempotencySeed: seedOf(["gate6", "dispute", found.id]),
        body: {
          disputed_transactions: [{ buyer_transaction_id: found.id }],
          reason: DISPUTE_REASON,
          dispute_amount: { currency_code: CURRENCY, value: AMOUNT },
          extensions: {
            merchant_contacted: true,
            merchant_contacted_outcome: "NO_RESPONSE",
            merchandize_dispute_properties: { issue_type: "PRODUCT" },
          },
        },
      });
      // Sandbox dispute creation returns a 201 whose only content is a self
      // link, so the id has to come out of the link when no id field exists.
      disputeId =
        pick(filed.body, ["dispute_id"]) ??
        pick(filed.body, ["id"]) ??
        selfLinkId(filed.body);
      if (disputeId !== null) {
        ctx.record("dispute_id", disputeId);
        // Saved before anything else can fail, so a later error never orphans
        // a dispute that already exists.
        saveState("gate6", { ...saved, captureId, disputeId });
      }
      ctx.log(`create dispute returned http ${filed.status}`);

      if (disputeId === null) {
        return {
          ok: false,
          reason: `buyer app could not create a dispute: http ${filed.status}, ${errorSummary(filed.body, filed.debugId)}. Sandbox dispute creation is absent from PayPal's public OpenAPI spec, so this is the finding, not a code bug.`,
          ...(filed.status === 403 || filed.status === 404 ? { qualifier: "BLOCKED" } : {}),
        };
      }
      saveState("gate6", { ...saved, captureId, disputeId });
    } else {
      ctx.record("dispute_id (resumed)", disputeId);
    }

    // The dispute takes a moment to become actionable.
    let disputeStatus: string | null = null;
    const openDeadline = Date.now() + DISPUTE_POLL_BUDGET_MS;
    while (Date.now() < openDeadline) {
      const d = await seller.call({ method: "GET", path: `/v1/customer/disputes/${disputeId}` });
      disputeStatus = pick(d.body, ["status"]);
      ctx.log(`dispute ${disputeId} reads ${disputeStatus ?? "unreadable"}`);
      if (disputeStatus !== null && disputeStatus !== "CREATION_IN_PROGRESS") break;
      await sleep(6000);
    }

    if (disputeStatus === null || disputeStatus === "CREATION_IN_PROGRESS") {
      return {
        ok: false,
        reason: `dispute ${disputeId} never became readable within ${DISPUTE_POLL_BUDGET_MS / 1000}s`,
        qualifier: "AMBIGUOUS",
      };
    }

    // Phase D: move it. require-evidence is sandbox-only and seller-side.
    //
    // A rejection here is NOT fatal to the run. Both sandbox endpoints are
    // undocumented as to life cycle stage, so the useful thing is to attempt
    // both and report both rather than stopping at the first refusal and
    // learning nothing about the second. The verdict below still demands both.
    const requireEv = await seller.call({
      method: "POST",
      path: `/v1/customer/disputes/${disputeId}/require-evidence`,
      idempotencySeed: seedOf(["gate6", "require-evidence", disputeId]),
      body: { action: "SELLER_EVIDENCE" },
    });
    const requireOk = requireEv.status >= 200 && requireEv.status < 300;
    ctx.log(`require-evidence returned http ${requireEv.status}`);
    if (!requireOk) {
      ctx.note(
        `require-evidence REJECTED: http ${requireEv.status}, ${errorSummary(requireEv.body, requireEv.debugId)}`,
      );
    }

    const afterRequire = await seller.call({
      method: "GET",
      path: `/v1/customer/disputes/${disputeId}`,
    });
    const requiredStatus = pick(afterRequire.body, ["status"]);
    const requiredStage = pick(afterRequire.body, ["dispute_life_cycle_stage"]);
    ctx.log(
      `dispute after require-evidence: status ${requiredStatus ?? "unreadable"}, stage ${requiredStage ?? "unreadable"}`,
    );

    // Phase E: settle it.
    const adjudicate = await seller.call({
      method: "POST",
      path: `/v1/customer/disputes/${disputeId}/adjudicate`,
      idempotencySeed: seedOf(["gate6", "adjudicate", disputeId]),
      body: { adjudication_outcome: "SELLER_FAVOR" },
    });
    ctx.log(`adjudicate returned http ${adjudicate.status}`);
    if (adjudicate.status < 200 || adjudicate.status >= 300) {
      return {
        ok: false,
        reason: `on dispute ${disputeId} at stage ${requiredStage ?? "unreadable"}: require-evidence ${requireOk ? "accepted" : "REJECTED"}, adjudicate failed with http ${adjudicate.status}, ${errorSummary(adjudicate.body, adjudicate.debugId)}`,
      };
    }

    let finalStatus: string | null = null;
    let outcome: string | null = null;
    const settleDeadline = Date.now() + DISPUTE_POLL_BUDGET_MS;
    while (Date.now() < settleDeadline) {
      const d = await seller.call({ method: "GET", path: `/v1/customer/disputes/${disputeId}` });
      finalStatus = pick(d.body, ["status"]);
      outcome = pick(d.body, ["dispute_outcome", "outcome_code"]);
      ctx.log(`dispute ${disputeId} reads ${finalStatus ?? "?"} outcome ${outcome ?? "?"}`);
      if (finalStatus === "RESOLVED") break;
      await sleep(6000);
    }

    if (finalStatus !== "RESOLVED") {
      return {
        ok: false,
        reason: `adjudicate was accepted but dispute ${disputeId} reads ${finalStatus ?? "unreadable"}, not RESOLVED, within ${DISPUTE_POLL_BUDGET_MS / 1000}s`,
        qualifier: "AMBIGUOUS",
      };
    }

    // Both halves are required. Settling without being able to move it first is
    // a partial result, and a partial result must not print PASS.
    if (!requireOk) {
      return {
        ok: false,
        reason: `dispute ${disputeId} was filed by the buyer app and SETTLED to ${finalStatus} (${outcome ?? "outcome unreadable"}) by adjudicate, but require-evidence was rejected at stage ${requiredStage ?? "unreadable"}, so only the settle half is proven`,
        qualifier: "PARTIAL",
      };
    }

    return {
      ok: true,
      reason: `dispute ${disputeId} filed by the buyer app on capture ${captureId}, moved to ${requiredStatus ?? "?"} by require-evidence, then RESOLVED (${outcome ?? "outcome unreadable"}) by adjudicate`,
    };
  },
});
