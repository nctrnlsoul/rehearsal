import { type Scenario, cleanModelText, fromMinor, splitPartial, toMinor } from "./engine";
import { STEP_ASKS, money } from "./runStory";

/**
 * A plan as a person reads it: numbered steps with their amounts, then what
 * the run would move in total. Pure, from the scenario the gate passed, so
 * the list can only say what the run will do. Raw step kinds, the engine's
 * waves and the digest stay out of it; the page keeps those behind Details.
 */

export type PlanLine = { readonly n: number; readonly title: string; readonly amount: string | null; readonly note: string | null };
export type PlanTotal = { readonly label: string; readonly amount: string };
/** eventTarget: where PayPal delivers this run's events, in the engine dry run's own words (R-045). */
export type PlanView = { readonly steps: readonly PlanLine[]; readonly totals: readonly PlanTotal[]; readonly eventTarget: string };

const MAX_LABEL_CHARS = 80;

export function planView(scenario: Scenario): PlanView {
  const c = scenario.currency;
  const nOf = new Map(scenario.steps.map((s, i) => [s.id, i + 1]));
  const named = (id: string) => `step ${nOf.get(id) ?? "?"}`;
  const fmt = (minor: bigint) => money(c, fromMinor(minor, c));

  const steps = scenario.steps.map((s, i): PlanLine => {
    let title = STEP_ASKS[s.kind] ?? "Run a step";
    let amount: string | null = null;
    const notes: string[] = [];
    switch (s.kind) {
      case "card_order":
      case "invoice_create":
        amount = money(c, s.amount);
        if (s.kind === "invoice_create" && s.dueInDays !== undefined) notes.push(s.dueInDays < 0 ? `due ${-s.dueInDays} days ago, so it reads overdue` : `due in ${s.dueInDays} days`);
        break;
      case "refund": {
        const source = scenario.steps.find((x) => x.id === s.from);
        title = s.mode === "partial" ? `Send a partial refund${s.basisPoints === undefined ? "" : ` (${s.basisPoints / 100}%)`}` : "Send a full refund";
        if (source?.kind === "card_order") {
          const total = toMinor(source.amount, c);
          amount = fmt(s.mode === "partial" && s.basisPoints !== undefined ? splitPartial(total, s.basisPoints).refundMinor : total);
        }
        notes.push(`of the payment in ${named(s.from)}`);
        break;
      }
      case "payout_batch":
        amount = fmt(s.items.reduce((a, item) => a + toMinor(item.amount, c), 0n));
        notes.push(`${s.items.length} ${s.items.length === 1 ? "recipient" : "recipients"}${s.items.some((item) => item.unclaimed) ? ", some left unclaimed" : ""}`);
        break;
      case "invoice_send":
        notes.push(`the invoice from ${named(s.from)}; no email goes to anyone`);
        break;
      case "invoice_record_payment":
        if (s.amount !== undefined) amount = money(c, s.amount);
        notes.push(`on the invoice from ${named(s.from)}`);
        break;
      case "invoice_cancel":
        notes.push(`the invoice from ${named(s.from)}`);
        break;
      case "open_dispute":
        notes.push("against a banked sandbox purchase");
        break;
      case "resend_webhook":
        notes.push(`the payment event from ${named(s.from)}`);
        break;
    }
    // A model-written label is the plan's own name for the step; shown, never trusted as markup.
    const label = s.label === undefined ? null : cleanModelText(s.label, MAX_LABEL_CHARS);
    return { n: i + 1, title, amount, note: [label, ...notes].filter((x) => x !== null && x !== "").join("; ") || null };
  });

  const sum = (pick: (s: Scenario["steps"][number]) => bigint) => scenario.steps.reduce((a, s) => a + pick(s), 0n);
  const charged = sum((s) => (s.kind === "card_order" ? toMinor(s.amount, c) : 0n));
  const invoiced = sum((s) => (s.kind === "invoice_create" ? toMinor(s.amount, c) : 0n));
  const paidOut = sum((s) => (s.kind === "payout_batch" ? s.items.reduce((a, item) => a + toMinor(item.amount, c), 0n) : 0n));
  const totals: PlanTotal[] = [
    { label: "Cards charged", amount: fmt(charged) },
    { label: "Invoiced", amount: fmt(invoiced) },
    { label: "Paid out", amount: fmt(paidOut) },
  ];
  // A plan with no webhook registers none, but PayPal still delivers the
  // account's events to every webhook already registered on it.
  const eventTarget =
    scenario.webhook === undefined ? "none declared by this plan; PayPal still delivers this account's events to every webhook registered on it" : `on the allowlist: ${scenario.webhook.target}`;
  return { steps, totals, eventTarget };
}
