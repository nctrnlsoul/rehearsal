import finderData from "../fixtures/finder.json";
import plansData from "../fixtures/plans.json";
import runsData from "../fixtures/runs.json";
import type { LiveEvent, LiveRead } from "./liveView";

/**
 * Recorded runs, replayed. These surfaces make no live call: every one reads
 * these fixtures, and every page that shows them says REPLAY. The math here is
 * pure so the timeline's layout is tested without a browser.
 */

export type ReplayCall = {
  readonly step: string;
  readonly kind: string;
  readonly request: string;
  readonly what: string;
  readonly detail: string;
  readonly startedAt: string;
  readonly acceptedAt: string;
  readonly ids: Readonly<Record<string, string>>;
  /** The step's amount as the run's state file records it, when the step has one. */
  readonly amount?: string;
};

export type ReplayDelivery = {
  readonly pair: string;
  readonly eventType: string;
  readonly eventId: string;
  readonly at: string;
  readonly store: "fulfilled" | "duplicate_ignored";
  readonly verified: boolean;
  readonly certHost: string | null;
  readonly repeat?: boolean;
};

export type ReplayRun = {
  readonly runId: string;
  readonly scenarioName: string;
  readonly currency: string;
  readonly startedAt: string;
  readonly verdict: "bug" | "ok";
  readonly verdictLine: string;
  readonly sources: readonly string[];
  readonly calls: readonly ReplayCall[];
  readonly deliveries: readonly ReplayDelivery[];
};

// JSON imports infer loose types; tests/fixtures.test.ts checks the real shape instead.
export const RUNS: readonly ReplayRun[] = runsData.runs as unknown as ReplayRun[];

export function runById(runId: string): ReplayRun | undefined {
  return RUNS.find((r) => r.runId === runId);
}

/** Seconds from the run's start, to the millisecond the record holds. */
export const elapsedS = (run: ReplayRun, iso: string) => (Date.parse(iso) - Date.parse(run.startedAt)) / 1000;

export type TimelineRow =
  | { readonly kind: "call"; readonly t: number; readonly call: ReplayCall }
  | { readonly kind: "delivery"; readonly t: number; readonly delivery: ReplayDelivery; readonly latencyS: number };

/**
 * Calls (at the moment PayPal accepted them) and deliveries (when the store
 * recorded them), in time order. Latency runs from acceptance to delivery.
 */
export function timelineRows(run: ReplayRun): TimelineRow[] {
  const byStep = new Map(run.calls.map((c) => [c.step, c]));
  const rows: TimelineRow[] = run.calls.map((call) => ({ kind: "call", t: elapsedS(run, call.acceptedAt), call }));
  for (const delivery of run.deliveries) {
    const call = byStep.get(delivery.pair);
    if (call === undefined) throw new Error(`delivery for ${delivery.pair} has no call in run ${run.runId}`);
    rows.push({
      kind: "delivery",
      t: elapsedS(run, delivery.at),
      delivery,
      latencyS: (Date.parse(delivery.at) - Date.parse(call.acceptedAt)) / 1000,
    });
  }
  return rows.sort((a, b) => a.t - b.t);
}

export function utcTime(iso: string): string {
  return new Date(iso).toISOString().slice(11, 19);
}

/** The recorded run's own id names, as the engine writes them on a live run. */
const ENGINE_ID: Readonly<Record<string, string>> = { order: "order_id", capture: "capture_id", event: "resent_event_id", webhook: "webhook_id" };

/** When the replay ends: the last call or delivery, in seconds from the start. */
export const replayEndS = (run: ReplayRun) => Math.max(...timelineRows(run).map((r) => r.t));

/**
 * The recorded run as the live page would have read it tS seconds in: the
 * same events the worker writes, built only from the fixture's own calls,
 * ids and times. So a replay is drawn by the live run's own code, and a judge
 * without a passcode sees exactly what a live run looks like.
 */
export function replayRead(run: ReplayRun, tS: number): LiveRead {
  const t0 = Date.parse(run.startedAt);
  const at = (iso: string) => (Date.parse(iso) - t0) / 1000;
  const end = replayEndS(run);
  const done = tS >= end;
  const now = new Date(t0 + Math.min(tS, end) * 1000).toISOString();
  const events: Array<Omit<LiveEvent, "seq">> = [
    { at: run.startedAt, kind: "note", step_id: null, data: { plan: { currency: run.currency, steps: run.calls.map((c) => ({ id: c.step, kind: c.kind, ...(c.amount === undefined ? {} : { amount: c.amount }) })) } } },
  ];
  const captureOf = new Map<string, string>();
  for (const c of run.calls) {
    events.push({ at: c.startedAt, kind: "step_started", step_id: c.step, data: { kind: c.kind, attempt: 1 } });
    const ids = Object.fromEntries(Object.entries(c.ids).map(([k, v]) => [ENGINE_ID[k] ?? k, v]));
    if (ids["capture_id"] !== undefined) captureOf.set(c.step, ids["capture_id"]);
    events.push({ at: c.acceptedAt, kind: "step_finished", step_id: c.step, data: { kind: c.kind, status: "succeeded", detail: c.detail, ids, finished_at: c.acceptedAt } });
  }
  // The store reports each event's running totals; a resend makes a second report.
  const seen = new Map<string, { received: string[]; fulfilled: number; ignored: number; captures: string[]; hosts: string[] }>();
  for (const d of [...run.deliveries].sort((a, b) => Date.parse(a.at) - Date.parse(b.at))) {
    const s = seen.get(d.eventId) ?? { received: [], fulfilled: 0, ignored: 0, captures: [], hosts: [] };
    s.received.push(new Date(d.at).toISOString());
    if (d.store === "fulfilled") s.fulfilled += 1;
    else s.ignored += 1;
    const cap = captureOf.get(d.pair);
    if (cap !== undefined && !s.captures.includes(cap)) s.captures.push(cap);
    if (d.certHost !== null && !s.hosts.includes(d.certHost)) s.hosts.push(d.certHost);
    seen.set(d.eventId, s);
    events.push({
      at: d.at,
      kind: "delivery",
      step_id: null,
      data: {
        event_id: d.eventId,
        event_type: d.eventType,
        deliveries: s.received.length,
        fulfilled: s.fulfilled,
        duplicates_ignored: s.ignored,
        other: 0,
        refused: d.verified ? 0 : 1,
        cert_hosts: [...s.hosts],
        capture_ids: [...s.captures],
        received_at: [...s.received],
        seen_at: d.at,
      },
    });
  }
  const shown = events
    .filter((e) => at(e.at) <= tS + 1e-9)
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
    .map((e, i) => ({ ...e, seq: i + 1 }));
  const finishedAt = new Date(t0 + end * 1000).toISOString();
  return {
    run: {
      id: run.runId,
      kind: "scenario",
      plan_source: "recorded",
      plan_id: run.runId,
      scenario_sha256: null,
      status: done ? "complete" : "running",
      state: null,
      halt_reason: null,
      created_at: run.startedAt,
      started_at: run.startedAt,
      heartbeat_at: now,
      finished_at: done ? finishedAt : null,
    },
    events: shown,
    now,
  };
}

// ------------------------------------------------------------------ plans

type PlanStep = {
  id: string;
  kind: string;
  label?: string;
  amount?: string;
  needs: string[];
  from?: string;
  dueInDays?: number;
  reason?: string;
  itemName?: string;
};

export type ReplayPlan = {
  readonly plan: string;
  readonly description: string | null;
  readonly sha256: string;
  readonly capsTotal: string;
  readonly largestStep: string;
  readonly violations: number;
  readonly scenario: {
    readonly name: string;
    readonly currency: string;
    readonly profile: { readonly name: string; readonly description?: string; readonly country: string };
    readonly webhook?: { readonly target: string };
    readonly steps: readonly PlanStep[];
  };
};

export const PLAN_CAPS = plansData.caps;

/** "2000.00" as "2,000.00", for reading only; the stored value stays a plain decimal string. */
export function grouped(amount: string): string {
  const [whole, frac] = amount.split(".");
  return `${whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}${frac === undefined ? "" : `.${frac}`}`;
}
export const PLANS: readonly ReplayPlan[] = plansData.plans as unknown as ReplayPlan[];

/** One line per step, in the plan's own words where it has them. */
export function describeStep(step: PlanStep, currency: string): string {
  const money = (v: string | undefined) => (v === undefined ? "" : `${currency} ${v}`);
  const named = step.label ?? step.id;
  switch (step.kind) {
    case "card_order":
      return `${named}, ${money(step.amount)} captured by card`;
    case "invoice_create":
      return `${named}, ${money(step.amount)}${step.dueInDays === undefined ? "" : step.dueInDays < 0 ? `, due ${-step.dueInDays} days ago` : `, due in ${step.dueInDays} days`}`;
    case "invoice_send":
      return `${named}, no email to anyone`;
    case "invoice_record_payment":
      return `Record external payment${step.amount === undefined ? "" : ` of ${money(step.amount)}`}`;
    case "open_dispute":
      return "Dispute a banked purchase";
    default:
      return named;
  }
}

/** Money the plan charges and invoices, as the dry run reports it. */
export function planTotals(plan: ReplayPlan): { charged: string; invoiced: string; disputes: number; creates: number } {
  // Integer cents from the decimal string, as everywhere in REHEARSAL: no float touches money.
  const cents = (amount: string): bigint => {
    const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(amount);
    if (m === null) throw new Error(`amount ${amount} is not a two-place decimal`);
    return BigInt(m[1]!) * 100n + BigInt((m[2] ?? "").padEnd(2, "0"));
  };
  const sum = (kind: string) =>
    plan.scenario.steps
      .filter((s) => s.kind === kind && s.amount !== undefined)
      .reduce((a, s) => a + cents(s.amount!), 0n);
  const fmt = (c: bigint) => `${plan.scenario.currency} ${c / 100n}.${String(c % 100n).padStart(2, "0")}`;
  return {
    charged: fmt(sum("card_order")),
    invoiced: fmt(sum("invoice_create")),
    disputes: plan.scenario.steps.filter((s) => s.kind === "open_dispute").length,
    creates: plan.scenario.steps.length,
  };
}

// ------------------------------------------------------------------ finder

export const FINDER = finderData;
