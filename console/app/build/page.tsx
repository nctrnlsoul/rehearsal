import Link from "next/link";
import { Badge, Icon, Mark, ReplayBanner, SiteFooter, Topbar } from "../../components/chrome";
import { RECORDED_PLANS } from "../../components/StartHere";
import { PLANS, PLAN_CAPS, describeStep, grouped, planTotals } from "../../lib/replays";
import { STEP_TITLES, money } from "../../lib/runStory";
import "./build.css";

// The dispute plan needs a banked purchase. This is the bank as it stood when
// the plan was recorded; the live builder at /live reads the live bank.
const BANK_AS_RECORDED = { usable: 0, on: "2026-10-24" };

export default async function BuildPage({ searchParams }: { searchParams: Promise<{ plan?: string }> }) {
  const { plan: chosen } = await searchParams;
  // Only a recorded plan id selects; anything else shows the first one.
  const plan = PLANS.find((p) => p.plan === chosen) ?? PLANS[0]!;
  const s = plan.scenario;
  const totals = planTotals(plan);
  const blocked = totals.disputes > BANK_AS_RECORDED.usable;
  const card = RECORDED_PLANS.find((c) => c.plan === plan.plan)!;

  return (
    <div className="s-build">
      <a className="skip" href="#plan">Skip to the plan</a>
      <Topbar current="build" />
      <ReplayBanner>Recorded planner outputs. Nothing on this page calls a model or PayPal; planning and running live are behind the judge passcode.</ReplayBanner>
      <main>
        <section className="hero" aria-labelledby="build-h">
          <div className="wrap">
            <p className="eyebrow">Step 2 of 3 · read exactly what it will do</p>
            <h1 id="build-h">A plan, read before it runs.</h1>
            <p className="lead">The model writes a plan. The schema, the spend caps and the event-target allowlist decide whether it may run. Nothing reaches PayPal until you press Run.</p>
          </div>
        </section>

        <div className="wrap lift build-grid">
          <nav className="card recorded" aria-labelledby="rec-h">
            <h2 id="rec-h">Recorded plans</h2>
            <ul>
              {PLANS.map((p) => {
                const c = RECORDED_PLANS.find((x) => x.plan === p.plan)!;
                const isBlocked = planTotals(p).disputes > BANK_AS_RECORDED.usable;
                return (
                  <li key={p.plan}>
                    <Link href={`/build?plan=${p.plan}`} aria-current={p.plan === plan.plan ? "true" : undefined}>
                      <span className="nm">{c.name}</span>
                      <span className="sum">{c.summary}</span>
                      <span className="st">{isBlocked ? <Mark kind="stop">needs a banked purchase</Mark> : <Mark kind="ok">ready to run</Mark>}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
            <div className="said">
              <h3>What was described</h3>
              {plan.description === null ? (
                <p className="note">Not saved. The CLI keeps the plan it made, not the words it came from, so this page cannot show them.</p>
              ) : (
                <q>{plan.description}</q>
              )}
            </div>
            <p className="note">Planning from your own words calls the model once per plan, at most 4,000 output tokens and 60 seconds, behind the judge passcode.</p>
          </nav>

          <article className={`card plan${blocked ? " blocked" : ""}`} id="plan" aria-labelledby="plan-h">
            <div className="plan-head">
              <h2 id="plan-h">{card.name}</h2>
              <p className="about">{s.profile.name} ({s.profile.country}){s.profile.description === undefined ? "" : `. ${s.profile.description}`}</p>
              <p className="plan-sum">{card.summary}</p>
            </div>

            <ol className="creates" aria-label="What this plan does in the PayPal sandbox, in order">
              {s.steps.map((st, i) => (
                <li key={st.id}>
                  <span className="cn" aria-hidden="true">{i + 1}</span>
                  <span className="cw">
                    <span className="ct">{STEP_TITLES[st.kind] ?? describeStep(st, s.currency)}{st.amount !== undefined && <>, {money(s.currency, st.amount)}</>}</span>
                    <span className="cd">{describeStep(st, s.currency)}{st.needs.length > 0 ? `; after ${st.needs.join(", ")}` : ""}</span>
                  </span>
                  <span className="ck mono">{st.kind}</span>
                </li>
              ))}
            </ol>

            <dl className="checks" aria-label="Checks this plan passed">
              <dt>Schema</dt><dd><Badge kind="ok">passed</Badge></dd>
              <dt>Spend caps</dt>
              <dd>
                <Badge kind="ok">within</Badge>{" "}
                {s.currency} {grouped(plan.capsTotal)} of {grouped(PLAN_CAPS.perRun)} per run; charges, invoices and recorded payments all count. Largest step {s.currency} {grouped(plan.largestStep)} of {grouped(PLAN_CAPS.perStep)}. {s.steps.length} of {PLAN_CAPS.steps} steps, {totals.disputes} of {PLAN_CAPS.disputes} disputes.
              </dd>
              <dt>Event target</dt><dd>{s.webhook === undefined ? "none declared by this plan; PayPal still delivers this account's events to every webhook registered on it" : <>on the allowlist: <span className="mono">{s.webhook.target}</span></>}</dd>
              <dt>Purchase bank</dt>
              <dd>{totals.disputes === 0 ? "not used by this plan" : <>needs {totals.disputes}, usable {BANK_AS_RECORDED.usable} as recorded on {BANK_AS_RECORDED.on}</>}</dd>
            </dl>

            <details className="json">
              <summary>The exact scenario that would run (JSON, as saved) <Icon name="chevron" /></summary>
              <pre className="mono">{JSON.stringify(s, null, 2)}</pre>
            </details>

            {blocked ? (
              <div className="why">
                <Mark kind="stop">Blocked: needs a banked purchase (run bank:add)</Mark>
                <span className="note">Each banked purchase costs a human approval click, so the plan waits rather than guessing.</span>
                <span className="btn" aria-disabled="true" role="button">Run this exact plan</span>
              </div>
            ) : (
              <div className="confirm">
                <Link className="btn btn-primary" href="/live">Run this exact plan <Icon name="arrow" /></Link>
                <p className="note">A run records this plan&apos;s digest, and a resume must present the same one. Live runs need the judge passcode.</p>
                <p className="digest"><span className="mono">sha256 {plan.sha256}</span></p>
              </div>
            )}
          </article>
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
