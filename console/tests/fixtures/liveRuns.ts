import { type HostedReplay, hostedEndS } from "../../lib/hostedReplays";
import { type ReplayRun, replayRead } from "../../lib/replays";

/**
 * Live-run fixtures, as the events the worker writes, each at a time in
 * seconds from the run's start. Four sources, never mixed:
 *
 * - recordedAt: a recorded run (fixtures/runs.json), its own ids and times,
 *   cut at a moment of its clock. This is how the live page is driven from a
 *   recorded fixture: no PayPal call, no invented id.
 * - tinyBakery: the shape of a Tiny Bakery run (plan-20261023193216), to
 *   exercise five steps, an invoice and a step with no event. Every id here
 *   is marked E2E and none resolves at PayPal.
 * - hostedAt: hosted run 20261107230012-f3bb0a, its own rows and ids, with
 *   each time made relative to its start.
 * - tokenRefused: run 20261107203953-bd8593 as the fixed engine records it:
 *   the token request answered 401 invalid_client before any write.
 */

export type FixtureEvent = { s: number; kind: string; step?: string; data?: Record<string, unknown> };
export type Fixture = { status: string; events: FixtureEvent[]; reason?: string; startedS?: number };

export function recordedAt(run: ReplayRun, tS: number): Fixture {
  const read = replayRead(run, tS);
  const t0 = Date.parse(run.startedAt);
  return {
    status: read.run.status,
    events: read.events.map((e) => ({ s: (Date.parse(e.at) - t0) / 1000, kind: e.kind, ...(e.step_id === null ? {} : { step: e.step_id }), data: e.data })),
  };
}

/**
 * A hosted run's own rows, cut at tS seconds, as a fixture: every event and
 * id unchanged, every time inside them made relative to the run's start, so
 * the live page can be fed the recorded run on today's clock.
 */
export function hostedAt(h: HostedReplay, tS: number): Fixture {
  const t0 = Date.parse(h.record.run.started_at ?? h.record.run.created_at);
  const rel = (v: unknown): unknown => {
    if (typeof v === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d/.test(v)) return { rel: (Date.parse(v) - t0) / 1000 };
    if (Array.isArray(v)) return v.map(rel);
    if (typeof v === "object" && v !== null) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, rel(x)]));
    return v;
  };
  const done = tS >= hostedEndS(h);
  return {
    status: done ? h.record.run.status : "running",
    events: h.record.events
      .filter((e) => (Date.parse(e.at) - t0) / 1000 <= tS)
      .map((e) => ({ s: (Date.parse(e.at) - t0) / 1000, kind: e.kind, ...(e.step_id === null ? {} : { step: e.step_id }), data: rel(e.data) as Record<string, unknown> })),
  };
}

const PLAN = {
  currency: "USD",
  steps: [
    { id: "card-order-1", kind: "card_order", amount: "45.00" },
    { id: "card-order-2", kind: "card_order", amount: "60.00" },
    { id: "invoice-1", kind: "invoice_create", amount: "120.00" },
    { id: "invoice-1-send", kind: "invoice_send", from: "invoice-1" },
    { id: "invoice-1-payment", kind: "invoice_record_payment", amount: "120.00", from: "invoice-1" },
  ],
};

/** Tiny Bakery, cut at tS seconds. Calls take 1 to 2 s; PayPal's events land 9 to 20 s later. */
export function tinyBakery(tS: number): Fixture {
  const steps: Array<{ id: string; kind: string; start: number; end: number; ids: Record<string, string>; from?: string }> = [
    { id: "card-order-1", kind: "card_order", start: 1, end: 2.4, ids: { order_id: "E2E-ORDER-1", capture_id: "E2E-CAPTURE-1" } },
    { id: "card-order-2", kind: "card_order", start: 3, end: 4.2, ids: { order_id: "E2E-ORDER-2", capture_id: "E2E-CAPTURE-2" } },
    { id: "invoice-1", kind: "invoice_create", start: 5, end: 6.1, ids: { invoice_number: "E2E-0001", invoice_id: "INV2-E2E-INVOICE-1" } },
    { id: "invoice-1-send", kind: "invoice_send", start: 7, end: 8, ids: {}, from: "invoice-1" },
    { id: "invoice-1-payment", kind: "invoice_record_payment", start: 9, end: 10.3, ids: { invoice_payment_id: "E2E-PAYMENT-1" }, from: "invoice-1" },
  ];
  const deliveries = [
    { at: 14.4, id: "WH-E2E-CAPTURE-1", type: "PAYMENT.CAPTURE.COMPLETED", capture: "E2E-CAPTURE-1", fulfilled: 1 },
    { at: 18.0, id: "WH-E2E-INVOICE-CREATED", type: "INVOICING.INVOICE.CREATED", capture: "INV2-E2E-INVOICE-1", fulfilled: 0 },
    { at: 24.2, id: "WH-E2E-CAPTURE-2", type: "PAYMENT.CAPTURE.COMPLETED", capture: "E2E-CAPTURE-2", fulfilled: 1 },
    { at: 26.5, id: "WH-E2E-INVOICE-PAID", type: "INVOICING.INVOICE.PAID", capture: "INV2-E2E-INVOICE-1", fulfilled: 0 },
    { at: 27.1, id: "WH-E2E-INVOICE-UPDATED", type: "INVOICING.INVOICE.UPDATED", capture: "INV2-E2E-INVOICE-1", fulfilled: 0 },
  ];
  const events: FixtureEvent[] = [{ s: 0, kind: "run_started" }, { s: 0, kind: "note", data: { plan: PLAN } }];
  for (const st of steps) {
    if (st.start <= tS) events.push({ s: st.start, kind: "step_started", step: st.id, data: { kind: st.kind, attempt: 1 } });
    if (st.end <= tS) {
      events.push({
        s: st.end,
        kind: "step_finished",
        step: st.id,
        data: { kind: st.kind, status: "succeeded", detail: `status ok`, ids: st.ids, finished_at: null, ...(st.from === undefined ? {} : { from: st.from }) },
      });
    }
  }
  const lastCall = steps[steps.length - 1]!.end;
  if (lastCall + 0.5 <= tS) events.push({ s: lastCall + 0.5, kind: "deliveries_wait_started", data: { seconds: 90 } });
  for (const d of deliveries) {
    if (d.at > tS) continue;
    events.push({
      s: d.at + 1,
      kind: "delivery",
      data: { event_id: d.id, event_type: d.type, deliveries: 1, fulfilled: d.fulfilled, duplicates_ignored: 0, other: 1 - d.fulfilled, refused: 0, cert_hosts: ["api.sandbox.paypal.com"], capture_ids: [d.capture], received_at: [{ rel: d.at }] },
    });
  }
  const done = tS >= 40;
  if (done) events.push({ s: 40, kind: "deliveries_wait_ended", data: { events_seen: deliveries.length } }, { s: 40, kind: "run_finished", data: { status: "complete" } });
  return { status: done ? "complete" : "running", events };
}

/**
 * The shape of hosted run 20261108033057-cfccbd: one dispute against a banked
 * USD 88 purchase, about 110 s at "Sending" while PayPal makes the case
 * readable, then a 90 s wait the dispute webhook did not arrive in. Every id is
 * marked E2E and none resolves at PayPal; the run's own record is not read.
 * paypalCapture: what PayPal's read-back names; undefined when it names none.
 */
export function disputeRun(tS: number, paypalCapture?: string): Fixture {
  const banked = "E2E-CAPTURE-BANK-1";
  const OPEN = "dispute PP-R-E2E-DISPUTE-1 open at WAITING_FOR_SELLER_RESPONSE, stage INQUIRY";
  const pairing =
    paypalCapture === undefined
      ? "PayPal did not name the capture"
      : paypalCapture === banked
        ? `PayPal names capture ${banked}, the banked capture`
        : `pairing_mismatch: banked capture ${banked}, PayPal says ${paypalCapture}`;
  const ids: Record<string, string> = {
    purchase_order_id: "E2E-ORDER-BANK-1",
    purchase_capture_id: banked,
    buyer_transaction_id: "E2E-TXN-BANK-1",
    dispute_amount: "88.00",
    dispute_id: "PP-R-E2E-DISPUTE-1",
    ...(paypalCapture === undefined ? {} : { paypal_seller_transaction_id: paypalCapture }),
  };
  const plan = { currency: "USD", steps: [{ id: "dispute-1", kind: "open_dispute", reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED" }] };
  const events: FixtureEvent[] = [{ s: 0, kind: "run_started" }, { s: 0, kind: "note", data: { plan } }];
  if (tS >= 1) events.push({ s: 1, kind: "step_started", step: "dispute-1", data: { kind: "open_dispute", attempt: 1 } });
  if (tS >= 111) {
    events.push({
      s: 111,
      kind: "step_finished",
      step: "dispute-1",
      // As the engine writes it: a mismatch leads the detail, any other note follows it.
      data: { kind: "open_dispute", status: "succeeded", detail: pairing.startsWith("pairing_mismatch") ? `${pairing}; ${OPEN}` : `${OPEN}; ${pairing}`, ids, finished_at: null },
    });
  }
  if (tS >= 111.5) events.push({ s: 111.5, kind: "deliveries_wait_started", data: { seconds: 90 } });
  const done = tS >= 201.5;
  if (done) events.push({ s: 201.5, kind: "deliveries_wait_ended", data: { events_seen: 0 } }, { s: 201.5, kind: "run_finished", data: { status: "complete" } });
  return { status: done ? "complete" : "running", events };
}

export const TOKEN_REFUSED_DETAIL = "not sent: the seller app's sandbox token request failed with http 401 (invalid_client), before any write";

export function tokenRefused(): Fixture {
  return {
    status: "halted",
    reason: `step card-order-1 failed: ${TOKEN_REFUSED_DETAIL}`,
    events: [
      { s: 0, kind: "run_started" },
      { s: 0, kind: "note", data: { plan: PLAN } },
      { s: 0.4, kind: "step_started", step: "card-order-1", data: { kind: "card_order", attempt: 1 } },
      { s: 0.9, kind: "step_finished", step: "card-order-1", data: { kind: "card_order", status: "failed", detail: TOKEN_REFUSED_DETAIL, ids: {}, finished_at: null } },
      { s: 0.9, kind: "run_halted", data: { reason: `step card-order-1 failed: ${TOKEN_REFUSED_DETAIL}` } },
      { s: 1.2, kind: "run_finished", data: { status: "halted" } },
    ],
  };
}

/**
 * Resolves a fixture's relative times against a start: { rel: s } inside data
 * becomes an ISO time, and finished_at null becomes the event's own time.
 */
export function absolute(f: Fixture, startMs: number): Array<{ at: string; kind: string; step_id: string | null; data: Record<string, unknown> }> {
  const iso = (s: number) => new Date(startMs + s * 1000).toISOString();
  const fix = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(fix);
    if (typeof v === "object" && v !== null) {
      const o = v as Record<string, unknown>;
      if (typeof o["rel"] === "number" && Object.keys(o).length === 1) return iso(o["rel"]);
      return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, fix(x)]));
    }
    return v;
  };
  return f.events.map((e) => {
    const data = fix(e.data ?? {}) as Record<string, unknown>;
    if (e.kind === "step_finished" && data["finished_at"] === null) data["finished_at"] = iso(e.s);
    return { at: iso(e.s), kind: e.kind, step_id: e.step ?? null, data };
  });
}
