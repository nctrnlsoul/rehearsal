import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SiteFooter, Topbar } from "../../components/chrome";
import { LiveBuilder } from "../../components/LiveBuilder";
import { HOSTED_CAPS, HOSTED_MODEL_LIMITS, HOSTED_RUN_LIMITS, TIME_BUDGET_S, liveRunsEnabled } from "../../lib/hosted";
import { PLANS } from "../../lib/replays";
import { SESSION_COOKIE, hasValidSession } from "../../lib/session";
import "../runs/timeline.css";
import "./live.css";

/**
 * Behind the gate: the live builder. The session is checked here before
 * anything renders, and again by every route the page calls.
 */
export default async function LivePage() {
  const jar = await cookies();
  if (!hasValidSession(jar.get(SESSION_COOKIE)?.value, process.env, Date.now())) redirect("/gate");
  const enabled = liveRunsEnabled(process.env);
  const plans = PLANS.map((p) => ({ plan: p.plan, name: p.scenario.name, description: p.description }));
  // The numbers shown are the constants the routes enforce, never retyped.
  const usd = (minor: bigint) => `USD ${(Number(minor) / 100).toFixed(2)}`;

  return (
    <div className="s-runs s-live">
      <a className="skip" href="#builder">Skip to the builder</a>
      <div className="live-banner" role="note"><strong>LIVE</strong><span>Runs here make real calls to PayPal&apos;s sandbox, within the hosted caps.</span></div>
      <Topbar current="live" />
      <header className="page">
        <div>
          <h1>Run a plan in PayPal&apos;s sandbox.</h1>
          <p className="runline">Read exactly what it becomes, then run that and only that. Every call and delivery fills in as it happens.</p>
        </div>
      </header>
      <main>
        <div id="builder">
          {enabled ? (
            <LiveBuilder plans={plans} />
          ) : (
            <section className="terminal" role="status">
              <h2>Live runs are paused on this deployment</h2>
              <p>You are past the gate, but this deployment is not taking live runs right now. <Link href="/runs">The recorded runs</Link> and <Link href="/finder">the finder&apos;s before and after</Link> still play, with real ids from real sandbox runs.</p>
            </section>
          )}
        </div>
        <aside aria-label="Hosted limits">
          <section className="facts-block">
            <h2 className="label">Hosted limits</h2>
            <dl className="facts">
              <dt>Per step</dt><dd>{usd(HOSTED_CAPS.maxStepAmountMinor)}</dd>
              <dt>Per run</dt><dd>{usd(HOSTED_CAPS.maxTotalMinor)}</dd>
              <dt>Steps</dt><dd>{HOSTED_CAPS.maxSteps}</dd>
              <dt>Disputes</dt><dd className="word">{HOSTED_CAPS.maxDisputes}, from the bank</dd>
              <dt>Worst-case time</dt><dd>{TIME_BUDGET_S} s</dd>
              <dt>Live runs a day</dt><dd className="word">{HOSTED_RUN_LIMITS.global}, {HOSTED_RUN_LIMITS.session} per session or address</dd>
              <dt>Planner calls a day</dt><dd className="word">{HOSTED_MODEL_LIMITS.global}, {HOSTED_MODEL_LIMITS.session} per session or address</dd>
              <dt>At once</dt><dd className="word">one run</dd>
            </dl>
          </section>
        </aside>
      </main>
      <SiteFooter>REHEARSAL · live · sandbox only</SiteFooter>
    </div>
  );
}
