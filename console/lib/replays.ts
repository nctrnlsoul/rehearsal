import finderData from "../fixtures/finder.json";
import plansData from "../fixtures/plans.json";
import runsData from "../fixtures/runs.json";

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

/**
 * The store records deliveries to the second, so a latency is shown to the
 * second. Printing tenths would claim a precision the record does not have.
 */
export function latencyLabel(seconds: number): string {
  return `${Math.max(0, Math.round(seconds))} s`;
}

/** Dead time compressed: grows with the square root of the gap, capped, so a long wait still reads longer. */
export function gapHeightPx(gapS: number): number {
  return Math.round(Math.min(40, 8 + Math.sqrt(Math.max(0, gapS)) * 4));
}

/** Gaps of 10 s or more are marked as broken axis on the spines. */
export const AXIS_BREAK_S = 10;

export function clock(seconds: number): string {
  const s = Math.max(0, seconds);
  return `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, "0")}`;
}

export function utcTime(iso: string): string {
  return new Date(iso).toISOString().slice(11, 19);
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
