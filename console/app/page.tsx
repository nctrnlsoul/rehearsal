import Link from "next/link";
import { Badge, Icon, SiteFooter, Topbar } from "../components/chrome";
import { RECORDED_PLANS, StartStrip } from "../components/StartHere";
import facts from "../fixtures/facts.json";
import { HOSTED_REPLAYS } from "../lib/hostedReplays";
import { DEFAULT_AI_BUDGET, DEFAULT_CAPS, DESCRIPTION_MAX_CHARS, HOSTED_CAPS, PLANNER_TIMEOUT_MS } from "../lib/hosted";
import "./home.css";

const usd = (minor: bigint) => `USD ${(Number(minor) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const count = (n: number) => n.toLocaleString("en-US");

export default function HomePage() {
  const t = facts.tests;
  return (
    <div className="s-home">
      <a className="skip" href="#start-h">Skip to Start here</a>
      <Topbar current="home" />
      <main>
        <section className="hero" aria-labelledby="home-h">
          <div className="wrap">
            <p className="eyebrow">A PayPal sandbox rehearsal for your webhook handling</p>
            <h1 id="home-h">Run a real business day in PayPal&apos;s sandbox, then see exactly what came back.</h1>
            <p className="lead">Rehearsal turns a short plan into real sandbox orders, refunds and invoices, then shows each call beside the webhook PayPal sent for it, signature checked.</p>
          </div>
        </section>

        <div className="wrap lift">
          <div className="card start-card">
            <StartStrip />
            <div className="start-actions">
              <Link className="btn btn-primary" href="/live">Run a plan live <Icon name="arrow" /></Link>
              <Link className="btn btn-quiet" href={`/runs/${HOSTED_REPLAYS[0]!.runId}`}>Watch a recorded run first</Link>
              <span className="note">Live runs need the judge passcode. Replays do not, and the first is a real hosted live run. <Link href="/runs">See every replay</Link>.</span>
            </div>
          </div>

          <div className="section-head">
            <h2 id="plans-h">Recorded plans</h2>
            <p>Ready to run as they are</p>
          </div>
          <ul className="plan-cards" aria-labelledby="plans-h">
            {RECORDED_PLANS.map((p) => (
              <li key={p.plan}>
                <Link className="card plan-card" href={`/build?plan=${p.plan}`}>
                  <span className="pc-name">{p.name}</span>
                  <span className="pc-sum">{p.summary}</span>
                  <span className="pc-meta">{p.steps} {p.steps === 1 ? "step" : "steps"}{p.disputes > 0 ? " · needs a banked purchase" : ""}</span>
                  <span className="pc-go">Read the plan <Icon name="arrow" /></span>
                </Link>
              </li>
            ))}
          </ul>

          <div className="section-head">
            <h2 id="facts-h">What it can and cannot do</h2>
            <p>Each limit is read from the code; test counts are measured</p>
          </div>
          <div className="trust" id="facts">
            <section className="card trust-block" aria-labelledby="reach-h">
              <h3 id="reach-h">Where it can reach</h3>
              <dl className="facts">
                <dt>PayPal host<small>a literal in code, not a setting</small></dt><dd className="mono">api-m.sandbox.paypal.com</dd>
                <dt>Live PayPal reachable</dt><dd>No, by construction</dd>
                <dt>Event targets<small>exact handler URL; the hosted demo allows only the sample store</small></dt><dd>Allowlisted only</dd>
              </dl>
            </section>
            <section className="card trust-block" aria-labelledby="move-h">
              <h3 id="move-h">How much it can move</h3>
              <p className="note">Per run, the defaults in code; a local install can change them with REHEARSAL_MAX_* variables.</p>
              <dl className="facts">
                <dt>Largest single step</dt><dd>{usd(DEFAULT_CAPS.maxStepAmountMinor)}</dd>
                <dt>Largest run</dt><dd>{usd(DEFAULT_CAPS.maxTotalMinor)}</dd>
                <dt>Steps per run</dt><dd>{DEFAULT_CAPS.maxSteps}</dd>
                <dt>Disputes per run</dt><dd>{DEFAULT_CAPS.maxDisputes}</dd>
                <dt>Hosted here, behind the passcode<small>fixed in code; a setting can lower them, never raise them</small></dt><dd>{usd(HOSTED_CAPS.maxStepAmountMinor)} a step, {usd(HOSTED_CAPS.maxTotalMinor)} a run, {HOSTED_CAPS.maxSteps} steps, {HOSTED_CAPS.maxDisputes} dispute</dd>
              </dl>
            </section>
            <section className="card trust-block" aria-labelledby="prove-h">
              <h3 id="prove-h">How it proves things</h3>
              <dl className="facts">
                <dt>Writes with an idempotency key<small>refused before sending if one is missing</small></dt><dd>every POST, PUT, PATCH</dd>
                <dt>Webhooks the sample store acts on<small>only after PayPal&apos;s verify call says SUCCESS; cert host on an exact list of 4</small></dt><dd>Verified only</dd>
                <dt>Webhooks the receiver records<small>every arrival, each marked verified, failed or not checked</small></dt><dd>All, marked</dd>
                <dt>Verdicts<small>no evidence reads INCONCLUSIVE, never OK</small></dt><dd>On evidence only</dd>
              </dl>
            </section>
            <section className="card trust-block" aria-labelledby="ai-h">
              <h3 id="ai-h">The AI planner</h3>
              <dl className="facts">
                <dt>Its plan is re-checked<small>schema, caps and allowlist on every reply</small></dt><dd>Always</dd>
                <dt>Per call</dt><dd>{count(DEFAULT_AI_BUDGET.maxOutputTokensPerCall)} tokens · {PLANNER_TIMEOUT_MS / 1000} s</dd>
                <dt>Description read<small>{count(DEFAULT_AI_BUDGET.maxInputChars)} from the CLI or MCP server</small></dt><dd>{count(DESCRIPTION_MAX_CHARS)} chars max here</dd>
              </dl>
              <p className="note">Keys stay on the server and are never printed, logged or returned. The MCP server is stdio only and runs on your own machine with your own keys.</p>
            </section>
          </div>

          <div className="proof-row">
            <section className="card tests" aria-labelledby="tests-h">
              <h3 id="tests-h">Tests passing</h3>
              <p className="big">{count(t.total)}</p>
              <p className="note">{t.engine} engine · {t.store} sample store · {t.receiver} receiver · {t.console} console · measured {facts.measuredOn} on {facts.version}</p>
            </section>
            <section className="card limits" aria-labelledby="limits-h">
              <h3 id="limits-h">What a pass here does not prove</h3>
              <ul>
                <li><Badge kind="stop">Live PayPal</Badge> Everything runs against the sandbox. A pass is evidence about your code&apos;s handling, not a promise about production.</li>
                <li><Badge kind="stop">Timing</Badge> PayPal&apos;s sandbox event list once lagged its own delivery by more than 2 min. When evidence does not arrive in time, the verdict is INCONCLUSIVE and you rerun.</li>
                <li><Badge kind="stop">Every dispute stage</Badge> Disputes open and wait on the merchant. The sandbox refuses require-evidence and adjudicate at the stage a new dispute starts in, so those are out of scope.</li>
                <li><Badge kind="stop">Every failure class</Badge> Proven on real runs: duplicate-webhook and refund-after-partial; the reports are in the repo under evidence/. Unclaimed-payout and overdue-invoice exist but are not claimed here. Dispute-on-a-refunded-order cannot be reached in this version and is reported as not tested.</li>
                <li><Badge kind="stop">Load</Badge> This rehearses business events one at a time. It is not a load or volume test.</li>
              </ul>
            </section>
          </div>
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
