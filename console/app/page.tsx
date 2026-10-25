import Link from "next/link";
import type { CSSProperties } from "react";
import { SiteFooter, Topbar } from "../components/chrome";
import facts from "../fixtures/facts.json";
import "./trust.css";

const Dash = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8h10" stroke="currentColor" strokeWidth="2" /></svg>
);
const order = (i: number) => ({ "--i": i }) as CSSProperties;

export default function TrustPage() {
  const t = facts.tests;
  return (
    <div className="s-trust">
      <a className="skip" href="#facts">Skip to the facts</a>
      <Topbar current="trust" />
      <main>
        <section className="facts-label arrive" style={order(0)} id="facts" aria-labelledby="facts-h">
          <h1 id="facts-h">REHEARSAL facts</h1>
          <p className="serving">Per run · the defaults in code; a local install can change them with REHEARSAL_MAX_* variables</p>
          <div className="bar-heavy" aria-hidden="true" />

          <p className="group-h">Where it can reach</p>
          <dl>
            <div className="line"><dt>PayPal host<small>a literal in code, not a setting</small></dt><dd>api-m.sandbox.paypal.com</dd></div>
            <div className="line"><dt>Live PayPal reachable</dt><dd className="word">No, by construction</dd></div>
            <div className="line"><dt>Event targets<small>exact handler URL; the hosted demo allows only the sample store</small></dt><dd className="word">Allowlisted only</dd></div>
          </dl>
          <div className="bar-mid" aria-hidden="true" />

          <p className="group-h">How much it can move</p>
          <dl>
            <div className="line"><dt>Largest single step</dt><dd>USD 500.00</dd></div>
            <div className="line"><dt>Largest run</dt><dd>USD 2,000.00</dd></div>
            <div className="line"><dt>Steps per run</dt><dd>30</dd></div>
            <div className="line"><dt>Disputes per run</dt><dd>2</dd></div>
          </dl>
          <div className="bar-mid" aria-hidden="true" />

          <p className="group-h">How it proves things</p>
          <dl>
            <div className="line"><dt>Writes with an idempotency key<small>refused before sending if one is missing</small></dt><dd>every POST, PUT, PATCH</dd></div>
            <div className="line"><dt>Webhooks the sample store acts on<small>only after PayPal&apos;s verify call says SUCCESS; cert host on an exact list of 4</small></dt><dd className="word">Verified only</dd></div>
            <div className="line"><dt>Webhooks the receiver records<small>every arrival, each marked verified, failed or not checked</small></dt><dd className="word">All, marked</dd></div>
            <div className="line"><dt>Verdicts<small>no evidence reads INCONCLUSIVE, never OK</small></dt><dd className="word">On evidence only</dd></div>
          </dl>
          <div className="bar-mid" aria-hidden="true" />

          <p className="group-h">The AI planner</p>
          <dl>
            <div className="line"><dt>Its plan is re-checked<small>schema, caps and allowlist on every reply</small></dt><dd className="word">Always</dd></div>
            <div className="line"><dt>Per call</dt><dd>4,000 tokens · 60 s</dd></div>
            <div className="line"><dt>Description read</dt><dd>4,000 chars max</dd></div>
          </dl>
          <div className="bar-heavy" aria-hidden="true" />
          <p className="foot">Keys stay on the server and are never printed, logged or returned. The MCP server is stdio only and runs on your own machine with your own keys.</p>
        </section>

        <section aria-labelledby="tests-h">
          <h2 id="tests-h" className="label">Tests passing</h2>
          <div className="big arrive" style={order(1)}>{t.total}<small>tests</small></div>
          <p className="split">{t.engine} engine · {t.store} sample store · {t.receiver} receiver · {t.console} console · measured {facts.measuredOn} on {facts.branch}</p>

          <p className="secline arrive" style={order(2)}>Sandbox only. Every write keyed and capped. No verdict without evidence.</p>

          <div className="limits arrive" style={order(3)}>
            <h2 className="label">What a pass here does not prove</h2>
            <ul>
              <li><Dash /><span><b>Live PayPal.</b> Everything runs against the sandbox. A pass is evidence about your code&apos;s handling, not a promise about production.</span></li>
              <li><Dash /><span><b>Timing you can count on.</b> PayPal&apos;s sandbox event list once lagged its own delivery by more than <span className="mono">2 min</span>. When evidence does not arrive in time, the verdict is INCONCLUSIVE and you rerun.</span></li>
              <li><Dash /><span><b>Every dispute stage.</b> Disputes open and wait on the merchant. The sandbox refuses require-evidence and adjudicate at the stage a new dispute starts in, so those are out of scope.</span></li>
              <li><Dash /><span><b>Every failure class.</b> Proven on real runs: duplicate-webhook and refund-after-partial. Unclaimed-payout and overdue-invoice exist but are not claimed here. Dispute-on-a-refunded-order cannot be reached in this version and is reported as not tested.</span></li>
              <li><Dash /><span><b>Load.</b> This rehearses business events one at a time. It is not a load or volume test.</span></li>
            </ul>
          </div>

          <div className="cta">
            <Link className="btn btn-primary" href="/build">Start a rehearsal</Link>
            <span className="note">Opens the scenario builder. Live runs need the judge passcode and arrive in Stage B.</span>
          </div>
        </section>
      </main>
      <SiteFooter>REHEARSAL · trust panel · every fact is backed by the code or a measured count</SiteFooter>
    </div>
  );
}
