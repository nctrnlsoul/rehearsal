import { fromMinor, toMinor } from "../core/money";
import { type RunState, summarize } from "../core/runState";
import type { Scenario, Step } from "../core/scenario";

/**
 * Renders a run report. Pure, so the report is testable and says only what the
 * run state actually recorded. A halted run is reported as halted, with the step
 * that stopped it named.
 */

const STATUS_MARK: Record<string, string> = {
  succeeded: "ok",
  failed: "FAILED",
  unknown: "UNKNOWN",
  pending: "not run",
};

export function runReportLines(scenario: Scenario, state: RunState): string[] {
  const sum = summarize(state);
  const lines: string[] = [];

  const verdict = state.halted
    ? "HALTED"
    : sum.complete
      ? "COMPLETE"
      : "INCOMPLETE";

  lines.push(`# Run report: ${scenario.name}`);
  lines.push("");
  lines.push(`- **Verdict:** ${verdict}`);
  lines.push(`- Run id: \`${state.runId}\``);
  lines.push(`- Business: ${scenario.profile.name} (${scenario.profile.country})`);
  lines.push(`- Currency: ${state.currency}`);
  lines.push(`- Started: ${state.startedAt}`);
  lines.push(`- Last update: ${state.updatedAt}`);
  lines.push(
    `- Steps: ${sum.succeeded} succeeded, ${sum.failed} failed, ${sum.unknown} unknown, ${sum.pending} not run, of ${sum.total}`,
  );
  if (state.halted) {
    lines.push(`- **Halt reason:** ${state.haltReason ?? "not recorded"}`);
  }
  for (const [key, value] of Object.entries(state.meta)) {
    lines.push(`- ${key}: \`${value}\``);
  }
  lines.push("");

  lines.push("## Steps");
  lines.push("");
  lines.push("| step | kind | status | detail |");
  lines.push("|---|---|---|---|");
  for (const id of state.order) {
    const rec = state.steps[id];
    if (rec === undefined) continue;
    const mark = STATUS_MARK[rec.status] ?? rec.status;
    lines.push(`| \`${id}\` | ${rec.kind} | ${mark} | ${rec.detail || "-"} |`);
  }
  lines.push("");

  lines.push("## PayPal ids created");
  lines.push("");
  if (sum.ids.length === 0) {
    lines.push("None. Nothing was created.");
  } else {
    lines.push("| step | label | id |");
    lines.push("|---|---|---|");
    for (const row of sum.ids) {
      lines.push(`| \`${row.step}\` | ${row.label} | \`${row.value}\` |`);
    }
  }
  lines.push("");

  // Only count money for steps that actually succeeded.
  const succeeded = new Set(
    Object.values(state.steps)
      .filter((s) => s.status === "succeeded")
      .map((s) => s.id),
  );
  const c = state.currency;
  const amountOf = (step: Step): bigint => {
    if (!succeeded.has(step.id)) return 0n;
    if (step.kind === "card_order" || step.kind === "invoice_create") {
      return toMinor(step.amount, c);
    }
    if (step.kind === "payout_batch") {
      return step.items.reduce((a, i) => a + toMinor(i.amount, c), 0n);
    }
    return 0n;
  };

  const charged = scenario.steps
    .filter((s) => s.kind === "card_order")
    .reduce((a, s) => a + amountOf(s), 0n);
  const invoiced = scenario.steps
    .filter((s) => s.kind === "invoice_create")
    .reduce((a, s) => a + amountOf(s), 0n);
  const paidOut = scenario.steps
    .filter((s) => s.kind === "payout_batch")
    .reduce((a, s) => a + amountOf(s), 0n);

  lines.push("## Money actually moved");
  lines.push("");
  lines.push(`- Cards charged: ${c} ${fromMinor(charged, c)}`);
  lines.push(`- Invoiced: ${c} ${fromMinor(invoiced, c)}`);
  lines.push(`- Paid out: ${c} ${fromMinor(paidOut, c)}`);
  lines.push("");
  lines.push("Figures count succeeded steps only, so a halted run does not overstate them.");

  return lines;
}
