import Link from "next/link";
import type { CSSProperties } from "react";
import { Mark, ReplayBanner, SiteFooter, Topbar } from "../../components/chrome";
import { PLANS, PLAN_CAPS, describeStep, grouped, planTotals } from "../../lib/replays";
import "./build.css";

const order = (i: number) => ({ "--i": i }) as CSSProperties;

// The demo-line plan needs a banked purchase. This is the bank as it stood when
// the plan was recorded; the live builder at /live reads the live bank.
const BANK_AS_RECORDED = { usable: 0, on: "2026-10-24" };

export default async function BuildPage({ searchParams }: { searchParams: Promise<{ plan?: string }> }) {
  const { plan: chosen } = await searchParams;
  // Only a recorded plan id selects; anything else shows the first one.
  const plan = PLANS.find((p) => p.plan === chosen) ?? PLANS[0]!;
  const s = plan.scenario;
  const totals = planTotals(plan);
  const blocked = totals.disputes > BANK_AS_RECORDED.usable;

  return (
    <div className="s-build">
      <a className="skip" href="#plan">Skip to the plan</a>
      <ReplayBanner>Recorded planner outputs, saved by the CLI. Nothing on this page calls a model or PayPal. Live planning and runs are behind the judge passcode, at /live.</ReplayBanner>
      <Topbar current="build" />
      <header className="page">
        <h1>Describe a business. Read exactly what it becomes. Then run that, and only that.</h1>
        <p>The model writes a plan. The schema, the spend caps and the event-target allowlist decide whether it may run. Nothing reaches PayPal until you press Run.</p>
      </header>

      <main>
        <section className="arrive" style={order(0)} aria-labelledby="said-h">
          <div className="steps-nav" aria-label="Builder steps">
            <span className="on"><b>01</b>Describe</span><span className="on"><b>02</b>Plan</span><span className="on"><b>03</b>Dry run</span><span><b>04</b>Run</span>
          </div>
          <h2 id="said-h" className="label" style={{ marginBottom: 8 }}>What was described</h2>
          <div className="said">
            {plan.description === null ? (
              <p className="none">Not saved. The CLI keeps the plan it made, not the words it came from, so this replay cannot show them.</p>
            ) : (
              <q>{plan.description}</q>
            )}
          </div>

          <nav className="recorded" aria-labelledby="rec-h">
            <h2 id="rec-h" className="label">Recorded plans</h2>
            <ul>
              {PLANS.map((p) => {
                const isBlocked = planTotals(p).disputes > BANK_AS_RECORDED.usable;
                return (
                  <li key={p.plan}>
                    <Link href={`/build?plan=${p.plan}`} aria-current={p.plan === plan.plan ? "true" : undefined}>
                      <span className="nm">{p.scenario.name}</span>
                      <span className="id">{p.plan}</span>
                      <span className="st">{isBlocked ? <Mark kind="stop">blocked</Mark> : <Mark kind="ok">runnable</Mark>}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </nav>
          <p className="note later">Planning from your own words calls the model once per plan, at most 4,000 output tokens and 60 seconds. It runs behind the judge passcode, at /live.</p>
        </section>

        <section className="arrive" style={order(1)} id="plan" aria-labelledby="plan-h">
          <article className={`plan${blocked ? " blocked" : ""}`}>
            <div className="plate"><span className="label">Plan</span><span className="mono">{plan.plan}</span></div>
            <div className="body">
              <h2 id="plan-h">{s.name}</h2>
              <p className="about">{s.profile.name} ({s.profile.country}){s.profile.description === undefined ? "" : ` · ${s.profile.description}`}</p>

              <ol className="creates" aria-label="What this plan creates in the PayPal sandbox">
                {s.steps.map((st) => (
                  <li key={st.id}>
                    <span className="plus" aria-hidden="true">+</span>
                    <span><span className="kind">{st.kind}</span><span className="id">{st.id}</span></span>
                    <span>
                      <span className="what">{describeStep(st, s.currency)}</span>
                      {st.kind === "open_dispute" && st.reason !== undefined && <> <span className="after">reason {st.reason}</span></>}
                      {st.needs.length > 0 && <> <span className="after">after {st.needs.join(", ")}</span></>}
                    </span>
                  </li>
                ))}
              </ol>
              <p className="totals">{totals.creates} to create · {totals.charged} charged · {totals.invoiced} invoiced · {totals.disputes} {totals.disputes === 1 ? "dispute" : "disputes"}</p>

              <dl className="checks" aria-label="Checks this plan passed">
                <dt>Schema</dt><dd><Mark kind="ok">passed</Mark></dd>
                <dt>Spend caps</dt>
                <dd>
                  <Mark kind="ok">within</Mark><br />
                  <span className="mono">{s.currency} {grouped(plan.capsTotal)} of {grouped(PLAN_CAPS.perRun)}</span> per run; charges, invoices and recorded payments all count<br />
                  largest step <span className="mono">{s.currency} {grouped(plan.largestStep)} of {grouped(PLAN_CAPS.perStep)}</span> · <span className="mono">{s.steps.length} of {PLAN_CAPS.steps}</span> steps · <span className="mono">{totals.disputes} of {PLAN_CAPS.disputes}</span> disputes
                </dd>
                <dt>Event target</dt><dd>{s.webhook === undefined ? "none declared by this plan; PayPal still delivers this account's events to every webhook registered on it" : <>on the allowlist: <span className="mono">{s.webhook.target}</span></>}</dd>
                <dt>Purchase bank</dt>
                <dd>{totals.disputes === 0 ? "not used by this plan" : <>needs <span className="mono">{totals.disputes}</span>, usable <span className="mono">{BANK_AS_RECORDED.usable}</span> as recorded on {BANK_AS_RECORDED.on}</>}</dd>
              </dl>

              <details className="json">
                <summary>The exact scenario that would run (JSON, as saved)</summary>
                <pre>{JSON.stringify(s, null, 2)}</pre>
              </details>

              {blocked ? (
                <div className="why">
                  <Mark kind="stop">BLOCKED: needs a banked purchase: run bank:add</Mark>
                  <span>Each banked purchase costs a human approval click, so the plan waits rather than guessing.</span>
                  <span className="btn" aria-disabled="true" role="button">Run this exact plan</span>
                </div>
              ) : (
                <div className="confirm">
                  <Link className="btn btn-primary" href="/live">Run this exact plan</Link>
                  <span className="digest">plan sha256 {plan.sha256}</span>
                  <p className="note">A run records this digest, and a resume must present the same one. Live runs need the judge passcode, at /live.</p>
                </div>
              )}
            </div>
          </article>
        </section>
      </main>
      <SiteFooter>REHEARSAL · scenario builder · plans, digests and cap totals are real; the cap totals were computed by the engine</SiteFooter>
    </div>
  );
}
