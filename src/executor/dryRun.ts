import { fromMinor, splitPartial, toMinor } from "../core/money";
import { topologicalOrder } from "../core/plan";
import type { Scenario, Step } from "../core/scenario";

/**
 * Renders the plan without touching the network. Pure by construction: it takes
 * no client and has no I/O, so "zero network calls" is a property of the type
 * signature rather than a promise in a comment.
 */

function describe(step: Step, scenario: Scenario): string {
  const c = scenario.currency;
  switch (step.kind) {
    case "card_order":
      return `card order ${c} ${step.amount}, captured in one call`;
    case "refund": {
      const source = scenario.steps.find((s) => s.id === step.from);
      if (source === undefined || source.kind !== "card_order") {
        return `${step.mode} refund of ${step.from}`;
      }
      if (step.mode === "full") return `full refund of ${c} ${source.amount} from ${step.from}`;
      const part = fromMinor(
        splitPartial(toMinor(source.amount, c), step.basisPoints!).refundMinor,
        c,
      );
      return `partial refund ${c} ${part} of ${source.amount} from ${step.from} (${step.basisPoints} bp)`;
    }
    case "payout_batch": {
      const parts = step.items.map(
        (i) => `${c} ${i.amount}${i.unclaimed ? " unclaimed" : " claimed"}`,
      );
      return `payout batch of ${step.items.length}: ${parts.join(", ")}`;
    }
    case "invoice_create": {
      const due =
        step.dueInDays === undefined
          ? ""
          : step.dueInDays < 0
            ? `, due ${Math.abs(step.dueInDays)} days ago so it reads overdue`
            : `, due in ${step.dueInDays} days`;
      return `invoice for ${c} ${step.amount}${due}`;
    }
    case "invoice_send":
      return `send invoice ${step.from}, no email to anyone`;
    case "invoice_record_payment":
      return `record payment on invoice ${step.from}${step.amount === undefined ? "" : ` of ${c} ${step.amount}`}`;
    case "invoice_cancel":
      return `cancel invoice ${step.from}`;
    case "open_dispute":
      return `open dispute from the purchase bank, reason ${step.reason}`;
    case "resend_webhook":
      return `ask PayPal to redeliver ${step.eventType} for ${step.from}`;
    default:
      return "unknown step";
  }
}

export function dryRunLines(scenario: Scenario): string[] {
  const plan = topologicalOrder(scenario.steps.map((s) => ({ id: s.id, needs: s.needs })));
  const lines: string[] = [];
  const c = scenario.currency;

  lines.push(`DRY RUN  ${scenario.name}`);
  lines.push(`  business   ${scenario.profile.name} (${scenario.profile.country})`);
  if (scenario.profile.description !== undefined) {
    lines.push(`  about      ${scenario.profile.description}`);
  }
  lines.push(`  currency   ${c}`);
  lines.push(
    scenario.webhook === undefined
      ? "  webhook    none declared, so no events will be delivered anywhere"
      : `  webhook    ${scenario.webhook.target} for [${scenario.webhook.eventTypes.join(", ")}]`,
  );
  lines.push(`  steps      ${scenario.steps.length}`);
  lines.push("");

  if (!plan.ok) {
    lines.push("PLAN INVALID, nothing would run:");
    for (const e of plan.errors) lines.push(`  ${e.code}: ${e.message}`);
    return lines;
  }

  const byId = new Map(scenario.steps.map((s) => [s.id, s]));
  plan.waves.forEach((wave, i) => {
    lines.push(`  wave ${i + 1}`);
    for (const id of wave) {
      const step = byId.get(id)!;
      const needs = step.needs.length === 0 ? "" : `  after ${step.needs.join(", ")}`;
      lines.push(`    ${id.padEnd(16)} ${step.kind.padEnd(22)} ${describe(step, scenario)}${needs}`);
    }
  });
  lines.push("");

  const sum = (pred: (s: Step) => string | null) =>
    scenario.steps.reduce((acc, s) => {
      const v = pred(s);
      return v === null ? acc : acc + toMinor(v, c);
    }, 0n);

  const charged = sum((s) => (s.kind === "card_order" ? s.amount : null));
  const invoiced = sum((s) => (s.kind === "invoice_create" ? s.amount : null));
  const paidOut = scenario.steps.reduce((acc, s) => {
    if (s.kind !== "payout_batch") return acc;
    return acc + s.items.reduce((a, i) => a + toMinor(i.amount, c), 0n);
  }, 0n);
  const disputes = scenario.steps.filter((s) => s.kind === "open_dispute").length;

  lines.push("  money this run would move");
  lines.push(`    cards charged   ${c} ${fromMinor(charged, c)}`);
  lines.push(`    invoiced        ${c} ${fromMinor(invoiced, c)}`);
  lines.push(`    paid out        ${c} ${fromMinor(paidOut, c)}`);
  lines.push("");
  lines.push("  prerequisites");
  lines.push(
    `    banked purchases needed: ${disputes}${disputes > 0 ? " (each one cost a human approval click)" : ""}`,
  );
  lines.push("");
  lines.push("  no network calls were made to produce this plan");

  return lines;
}
