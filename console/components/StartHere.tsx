import { HOSTED_CAPS, HOSTED_RUN_LIMITS } from "../lib/hosted";
import { PLANS, type ReplayPlan, grouped, planTotals } from "../lib/replays";

/** The three steps a judge takes, the same on the home page and the live builder. */
export function StartStrip({ current }: { current?: 1 | 2 | 3 }) {
  const usd = (minor: bigint) => `USD ${grouped((Number(minor) / 100).toFixed(2))}`;
  const steps = [
    { n: 1, title: "Pick a plan", body: "A recorded plan, or describe a business and let the planner write one." },
    { n: 2, title: "Read exactly what it will do", body: "A dry run lists every call and amount before anything is sent." },
    { n: 3, title: "Run it live in the sandbox", body: "Watch each call and the webhook PayPal sends for it arrive side by side." },
  ] as const;
  return (
    <section className="start" aria-labelledby="start-h">
      <h2 id="start-h" className="sr">Start here</h2>
      <ol className="start-steps">
        {steps.map((s) => (
          <li key={s.n} className={current === s.n ? "on" : undefined} aria-current={current === s.n ? "step" : undefined}>
            <span className="start-n" aria-hidden="true">{s.n}</span>
            <span>
              <span className="start-title">{s.title}</span>
              <span className="start-body">{s.body}</span>
            </span>
          </li>
        ))}
      </ol>
      <p className="start-cost">
        It costs nothing: every call goes to PayPal&apos;s sandbox, never live PayPal. Live runs are capped at {usd(HOSTED_CAPS.maxStepAmountMinor)} a step and {usd(HOSTED_CAPS.maxTotalMinor)} a run, {HOSTED_CAPS.maxSteps} steps, one run at a time, {HOSTED_RUN_LIMITS.session} per session a day.
      </p>
    </section>
  );
}

/** "2 card orders + an invoice, USD 345": what a recorded plan does, in a line. */
export function planSummary(p: ReplayPlan): string {
  const steps = p.scenario.steps;
  const n = (kind: string) => steps.filter((s) => s.kind === kind).length;
  const parts: string[] = [];
  const cards = n("card_order");
  if (cards > 0) parts.push(cards === 1 ? "a card order" : `${cards} card orders`);
  const invoices = n("invoice_create");
  if (invoices > 0) parts.push(invoices === 1 ? "an invoice" : `${invoices} invoices`);
  const disputes = n("open_dispute");
  if (disputes > 0) parts.push(disputes === 1 ? "a dispute on a banked purchase" : `${disputes} disputes`);
  const refunds = n("refund");
  if (refunds > 0) parts.push(refunds === 1 ? "a refund" : `${refunds} refunds`);
  const total = Number(p.capsTotal) > 0 ? `, ${p.scenario.currency} ${grouped(p.capsTotal).replace(/\.00$/, "")}` : "";
  return `${parts.join(" + ") || `${steps.length} steps`}${total}`;
}

export const RECORDED_PLANS = PLANS.map((p) => ({ plan: p.plan, name: p.scenario.name.replace(/ Sandbox Scenario$/, ""), summary: planSummary(p), steps: p.scenario.steps.length, disputes: planTotals(p).disputes }));
