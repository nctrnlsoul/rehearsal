import { credentialsFor, optionalEnv } from "../src/adapters/env";
import { PaypalClient } from "../src/adapters/paypal";
import { assertAllowedEventTarget } from "../src/core/eventTarget";
import { seedOf, senderBatchId } from "../src/core/idempotency";
import { fromMinor, splitPartial, toMinor } from "../src/core/money";
import { classify } from "../src/core/outcome";
import { type Arrival, type Expectation, reconcile } from "../src/core/webhookLedger";
import { CURRENCY, cardOrderBody, unclaimedReceiver } from "./_fixtures";
import { errorSummary, pick, runGate, saveState, sleep } from "./_harness";

/**
 * Gate 5: webhook reliability against a real public endpoint.
 *
 * Register a webhook, cause real events, then reconcile three independent
 * records: what we did, what PayPal says it sent, and what the receiver
 * actually got. Finally resend one event and confirm it arrives twice.
 *
 * PayPal's own Webhook Simulator cannot do any of this: its events cannot be
 * verified, resent, or looked up. That is the gap this gate is measuring.
 */

const WEBHOOK_PATH = "/api/paypal/webhook";
const LEDGER_PATH = "/api/paypal/ledger";
const MIN_EVENTS = 5;
const EVENT_POLL_BUDGET_MS = 150_000;
const LEDGER_POLL_BUDGET_MS = 90_000;
const RESEND_POLL_BUDGET_MS = 90_000;
const ORDER_AMOUNT = "63.00";
const PAYOUT_AMOUNT = "4.00";
const REFUND_BASIS_POINTS = 2500;

type LedgerRow = {
  eventId: string | null;
  eventType: string | null;
  receivedAtMs: number;
  verified: boolean | null;
  verifyDetail: string;
  instanceId: string;
};

type LedgerSnapshot = {
  instanceId: string;
  bootedAtMs: number;
  nowMs: number;
  rows: LedgerRow[];
};

function arrayOf(body: unknown, key: string): Record<string, unknown>[] {
  const holder = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  const raw = holder[key];
  return Array.isArray(raw) ? (raw.filter((r) => typeof r === "object" && r !== null) as Record<string, unknown>[]) : [];
}

await runGate({
  id: "5",
  title: "webhook reliability: register, fire real events, reconcile, resend",
  async run(ctx) {
    const origin = optionalEnv("REHEARSAL_RECEIVER_ORIGIN");
    if (origin === null) {
      return {
        ok: false,
        reason:
          "REHEARSAL_RECEIVER_ORIGIN is not set. Deploy receiver/ to Vercel and set that variable to its origin, for example https://rehearsal-receiver.vercel.app",
        qualifier: "BLOCKED",
      };
    }
    const token = optionalEnv("REHEARSAL_RECEIVER_TOKEN");
    if (token === null) {
      return {
        ok: false,
        reason:
          "REHEARSAL_RECEIVER_TOKEN is not set. Set the same value here and in the Vercel project, without pasting it into chat.",
        qualifier: "BLOCKED",
      };
    }

    // The allowlist is the deliberately configured origin and nothing else, so
    // no argv value and no URL echoed back from an API response can be targeted.
    const webhookTarget = assertAllowedEventTarget(`${origin}${WEBHOOK_PATH}`, [origin]).toString();
    const ledgerUrl = assertAllowedEventTarget(`${origin}${LEDGER_PATH}`, [origin]).toString();
    ctx.log(`target ${webhookTarget}`);

    // Scope every read to this run's window. The ledger caps how many rows it
    // returns, so relying on that cap alone would let an older backlog, or
    // anyone posting junk to the public webhook endpoint, push this run's real
    // arrivals out of view.
    const ledgerSince = new Date(Date.now() - 60_000).toISOString();

    const readLedger = async (): Promise<LedgerSnapshot> => {
      const url = new URL(ledgerUrl);
      url.searchParams.set("since", ledgerSince);
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`ledger read returned http ${res.status}`);
      return (await res.json()) as LedgerSnapshot;
    };

    let baseline: LedgerSnapshot;
    try {
      baseline = await readLedger();
    } catch (e) {
      return {
        ok: false,
        reason: `receiver ledger unreachable: ${(e as Error).message}. Check the deployment is public (Vercel Deployment Protection off) and that REHEARSAL_RECEIVER_TOKEN matches on both sides.`,
        qualifier: "BLOCKED",
      };
    }
    ctx.log(`receiver reachable, instance ${baseline.instanceId}, ${baseline.rows.length} existing rows`);

    // Positive control on the measuring instrument, before any real event is
    // fired. If a write we make ourselves cannot be read back, then "missing"
    // means nothing. The absence of this check is what let an unreadable ledger
    // look exactly like five lost events.
    const probeId = `WH-REHEARSAL-SELFTEST-${ctx.runId}`;
    const probe = await fetch(webhookTarget, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: probeId,
        event_type: "REHEARSAL.SELFTEST",
        resource: { id: "selftest" },
      }),
      signal: AbortSignal.timeout(15_000),
    });
    ctx.log(`ledger self-test POST returned http ${probe.status}`);

    let ledgerVerified = false;
    for (let attempt = 1; attempt <= 3 && !ledgerVerified; attempt += 1) {
      const snap = await readLedger();
      ledgerVerified = snap.rows.some((r) => r.eventId === probeId);
      ctx.log(
        `ledger self-test read ${attempt}: instance ${snap.instanceId}, probe ${ledgerVerified ? "VISIBLE" : "not visible"}`,
      );
      if (!ledgerVerified && attempt < 3) await sleep(4000);
    }

    if (!ledgerVerified) {
      return {
        ok: false,
        reason: `the receiver accepted our self-test event with http ${probe.status} but cannot read it back, so its ledger is write-invisible and any missing-event result would be meaningless. An in-memory ledger cannot work on Vercel because writes and reads land on different serverless instances. Replace it with a durable store before trusting this gate.`,
        qualifier: "BLOCKED",
      };
    }

    const client = new PaypalClient(credentialsFor("seller"), {
      label: "seller",
      log: ctx.log,
      minIntervalMs: 300,
    });

    // 1. Register the webhook, or reuse the one already pointing at this URL.
    const created = await client.call({
      method: "POST",
      path: "/v1/notifications/webhooks",
      idempotencySeed: seedOf(["gate5", "webhook", webhookTarget]),
      body: { url: webhookTarget, event_types: [{ name: "*" }] },
    });
    let webhookId = pick(created.body, ["id"]);

    if (webhookId === null) {
      ctx.log(`create returned http ${created.status}: ${errorSummary(created.body, created.bodyPreview)}`);
      const list = await client.call({ method: "GET", path: "/v1/notifications/webhooks" });
      const match = arrayOf(list.body, "webhooks").find((w) => w["url"] === webhookTarget);
      webhookId = typeof match?.["id"] === "string" ? match["id"] : null;
      if (webhookId !== null) ctx.note("reused the webhook already registered for this URL");
    }

    if (webhookId === null) {
      return {
        ok: false,
        reason: `could not register or find a webhook for ${webhookTarget}: http ${created.status}, ${errorSummary(created.body, created.bodyPreview)}`,
      };
    }
    ctx.record("webhook_id", webhookId);
    saveState("gate5", { webhookId, webhookTarget });

    // 2. Cause real events. Three actions, which between them produce order,
    //    capture, refund and payout events.
    const actionsStartedAtMs = Date.now();
    // PayPal rejects a start_time carrying milliseconds with VALIDATION_ERROR:
    // "Datetime needs to be in the ISO 8601 format specified in RFC 3339".
    const startTimeIso = new Date(actionsStartedAtMs - 120_000)
      .toISOString()
      .replace(/\.\d{3}Z$/, "Z");

    const order = await client.call({
      method: "POST",
      path: "/v2/checkout/orders",
      idempotencySeed: seedOf(["gate5", "order", ctx.runId]),
      extraHeaders: { Prefer: "return=representation" },
      body: cardOrderBody(ORDER_AMOUNT, "rehearsal-gate-5"),
    });
    const orderId = pick(order.body, ["id"]);
    const captureId = pick(order.body, ["purchase_units", 0, "payments", "captures", 0, "id"]);
    if (orderId !== null) ctx.record("order_id", orderId);
    if (captureId !== null) ctx.record("capture_id", captureId);

    const orderVerdict = classify({
      httpStatus: order.status,
      body: order.body,
      expect: ["COMPLETED"],
      knownFailed: ["VOIDED"],
    });
    if (orderVerdict.kind !== "success" || captureId === null) {
      return {
        ok: false,
        reason: `could not create the events to test with: order ${orderVerdict.kind}, http ${order.status}, ${errorSummary(order.body, order.bodyPreview)}`,
      };
    }

    const refundValue = fromMinor(
      splitPartial(toMinor(ORDER_AMOUNT, CURRENCY), REFUND_BASIS_POINTS).refundMinor,
      CURRENCY,
    );
    const refund = await client.call({
      method: "POST",
      path: `/v2/payments/captures/${captureId}/refund`,
      idempotencySeed: seedOf(["gate5", "refund", captureId, ctx.runId]),
      extraHeaders: { Prefer: "return=representation" },
      body: {
        amount: { value: refundValue, currency_code: CURRENCY },
        note_to_payer: "REHEARSAL gate 5 partial refund",
      },
    });
    const refundId = pick(refund.body, ["id"]);
    if (refundId !== null) ctx.record("refund_id", refundId);

    const payout = await client.call({
      method: "POST",
      path: "/v1/payments/payouts",
      idempotencySeed: seedOf(["gate5", "payout", ctx.runId]),
      body: {
        sender_batch_header: {
          sender_batch_id: senderBatchId(seedOf(["gate5", "batch", ctx.runId])),
          email_subject: "REHEARSAL sandbox payout",
          email_message: "Sandbox payout created by REHEARSAL gate 5.",
        },
        items: [
          {
            recipient_type: "EMAIL",
            receiver: unclaimedReceiver(ctx.runId),
            amount: { value: PAYOUT_AMOUNT, currency: CURRENCY },
            note: "REHEARSAL gate 5 unclaimed recipient",
            sender_item_id: "gate5-item-1",
          },
        ],
      },
    });
    const payoutBatchId = pick(payout.body, ["batch_header", "payout_batch_id"]);
    if (payoutBatchId !== null) ctx.record("payout_batch_id", payoutBatchId);

    // 3. Ask PayPal what it actually sent. This is the authoritative "expected"
    //    list, independent of both our actions and the receiver.
    let expected: Expectation[] = [];
    let listOk = false;
    let listError = "the event list was never queried";
    const eventDeadline = Date.now() + EVENT_POLL_BUDGET_MS;
    while (Date.now() < eventDeadline) {
      const listed = await client.call({
        method: "GET",
        path: `/v1/notifications/webhooks-events?page_size=50&start_time=${encodeURIComponent(startTimeIso)}`,
      });

      // A failed query must never read as "zero events". That is the fail-open
      // shape the standing rules single out, and it made a 400 look like silence.
      if (listed.status !== 200) {
        listOk = false;
        listError = `http ${listed.status}: ${errorSummary(listed.body, listed.bodyPreview)}`;
        ctx.log(`webhooks-events list FAILED, ${listError}`);
        await sleep(8000);
        continue;
      }
      listOk = true;

      expected = arrayOf(listed.body, "events")
        .map((e) => ({
          eventId: typeof e["id"] === "string" ? e["id"] : "",
          eventType: typeof e["event_type"] === "string" ? e["event_type"] : "",
          sentAtMs: typeof e["create_time"] === "string" ? Date.parse(e["create_time"]) : Number.NaN,
        }))
        .filter((e) => e.eventId !== "" && !Number.isNaN(e.sentAtMs) && e.sentAtMs >= actionsStartedAtMs);

      ctx.log(`PayPal reports ${expected.length} event(s) since our actions began`);
      if (expected.length >= MIN_EVENTS) break;
      await sleep(8000);
    }

    for (const e of expected) ctx.log(`  sent ${e.eventType} ${e.eventId}`);

    if (!listOk) {
      return {
        ok: false,
        reason: `could not read PayPal's own event list, so what it sent is unknown and nothing can be reconciled: ${listError}`,
        qualifier: "UNKNOWN",
      };
    }
    if (expected.length === 0) {
      return {
        ok: false,
        reason: `PayPal's event list read cleanly but reported no events in the window, so nothing could be delivered. Webhook ${webhookId} is registered for ${webhookTarget}.`,
        qualifier: "UNKNOWN",
      };
    }

    // 4. Wait for the receiver to see them.
    let arrivals: Arrival[] = [];
    const ledgerDeadline = Date.now() + LEDGER_POLL_BUDGET_MS;
    while (Date.now() < ledgerDeadline) {
      const snap = await readLedger();
      arrivals = snap.rows
        .filter((r): r is LedgerRow & { eventId: string } => typeof r.eventId === "string")
        .filter((r) => r.eventId !== probeId)
        .map((r) => ({
          eventId: r.eventId,
          eventType: r.eventType ?? "",
          receivedAtMs: r.receivedAtMs,
          verified: r.verified,
          instanceId: r.instanceId,
        }));
      const have = new Set(arrivals.map((a) => a.eventId));
      const outstanding = expected.filter((e) => !have.has(e.eventId)).length;
      ctx.log(`receiver has ${arrivals.length} row(s), ${outstanding} expected event(s) outstanding`);
      if (outstanding === 0) break;
      await sleep(5000);
    }

    const report = reconcile(expected, arrivals, { ledgerVerified });
    for (const m of report.matched) {
      ctx.log(`  arrived ${m.eventType} ${m.eventId} after ${m.latencyMs}ms verified=${m.verified}`);
    }
    for (const m of report.missing) ctx.log(`  MISSING ${m.eventType} ${m.eventId}`);
    for (const n of report.notes) ctx.note(n);

    // Only advise this when the arrivals actually show verification was skipped.
    // Printing it unconditionally meant the gate told Brian to enable something
    // in the same breath as reporting verified=true.
    if (report.matched.some((m) => m.verified === null)) {
      ctx.note(
        `set REHEARSAL_WEBHOOK_ID=${webhookId} and the seller credentials in the Vercel project so the receiver verifies signatures instead of recording verified=null`,
      );
    }

    // 5. Resend one event and confirm it arrives a second time.
    const resendTarget = report.matched[0] ?? null;
    if (resendTarget === null) {
      return {
        ok: false,
        reason: `no event arrived, so there is nothing to resend. ${report.missing.length} of ${expected.length} missing.`,
        qualifier: report.verdict === "ambiguous" ? "AMBIGUOUS" : "FAIL",
      };
    }

    const beforeCount = arrivals.filter((a) => a.eventId === resendTarget.eventId).length;
    const resend = await client.call({
      method: "POST",
      path: `/v1/notifications/webhooks-events/${resendTarget.eventId}/resend`,
      idempotencySeed: seedOf(["gate5", "resend", resendTarget.eventId, ctx.runId]),
      body: { webhook_ids: [webhookId] },
    });
    ctx.record("resent_event_id", resendTarget.eventId);
    ctx.log(`resend returned http ${resend.status}`);

    if (resend.status < 200 || resend.status >= 300) {
      return {
        ok: false,
        reason: `resend of ${resendTarget.eventId} failed: http ${resend.status}, ${errorSummary(resend.body, resend.bodyPreview)}`,
      };
    }

    let afterCount = beforeCount;
    const resendDeadline = Date.now() + RESEND_POLL_BUDGET_MS;
    while (Date.now() < resendDeadline) {
      const snap = await readLedger();
      afterCount = snap.rows.filter((r) => r.eventId === resendTarget.eventId).length;
      ctx.log(`resent event seen ${afterCount} time(s), was ${beforeCount}`);
      if (afterCount > beforeCount) break;
      await sleep(5000);
    }

    const resendArrived = afterCount > beforeCount;
    const verifiedCount = report.matched.filter((m) => m.verified === true).length;

    if (report.verdict !== "pass") {
      return {
        ok: false,
        reason: `${report.matched.length} of ${expected.length} events arrived, ${report.missing.length} missing; resend ${resendArrived ? "arrived" : "did not arrive"}`,
        qualifier: report.verdict === "ambiguous" ? "AMBIGUOUS" : "FAIL",
      };
    }
    if (!resendArrived) {
      return {
        ok: false,
        reason: `all ${expected.length} events arrived, but the resend of ${resendTarget.eventId} did not arrive within ${RESEND_POLL_BUDGET_MS / 1000}s`,
        qualifier: "AMBIGUOUS",
      };
    }
    if (expected.length < MIN_EVENTS) {
      return {
        ok: false,
        reason: `only ${expected.length} real events were produced, fewer than the ${MIN_EVENTS} this gate asks for, though all arrived and the resend worked`,
        qualifier: "SHORT",
      };
    }

    return {
      ok: true,
      reason: `${expected.length} real events sent, all ${report.matched.length} arrived (${verifiedCount} signature-verified), resend of ${resendTarget.eventId} arrived again`,
    };
  },
});
