import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { LiveBanner, SiteFooter, Topbar } from "../../components/chrome";
import { LiveBuilder } from "../../components/LiveBuilder";
import { RECORDED_PLANS, StartStrip } from "../../components/StartHere";
import { HOSTED_CAPS, HOSTED_FINDER, HOSTED_MODEL_LIMITS, HOSTED_RUN_LIMITS, TIME_BUDGET_S, liveRunsEnabled } from "../../lib/hosted";
import { PLANS } from "../../lib/replays";
import { SESSION_COOKIE, hasValidSession } from "../../lib/session";
import "./live.css";

/**
 * Behind the gate: the live builder. The session is checked here before
 * anything renders, and again by every route the page calls.
 */
export default async function LivePage() {
  const jar = await cookies();
  if (!hasValidSession(jar.get(SESSION_COOKIE)?.value, process.env, Date.now())) redirect("/gate");
  const enabled = liveRunsEnabled(process.env);
  const plans = PLANS.map((p) => {
    const card = RECORDED_PLANS.find((c) => c.plan === p.plan)!;
    return { plan: p.plan, name: card.name, summary: card.summary, description: p.description };
  });
  // The numbers shown are the constants the routes enforce, never retyped.
  const usd = (minor: bigint) => `USD ${(Number(minor) / 100).toFixed(2)}`;

  return (
    <div className="s-live">
      <a className="skip" href="#builder">Skip to the builder</a>
      <Topbar current="live" />
      <LiveBanner>Runs here make real calls to PayPal&apos;s sandbox, within the hosted caps.</LiveBanner>
      <main>
        <section className="hero" aria-labelledby="live-h">
          <div className="wrap">
            <p className="eyebrow">Run live · you are past the gate</p>
            <h1 id="live-h">Run a plan in PayPal&apos;s sandbox.</h1>
            <p className="lead">Read exactly what it becomes, then run that and only that. Each call and PayPal&apos;s reply fill in side by side as they happen.</p>
          </div>
        </section>
        <div className="wrap lift">
          <div className="card start-card"><StartStrip /></div>
          <div className="live-grid">
            <div id="builder">
              {enabled ? (
                <LiveBuilder plans={plans} finder={HOSTED_FINDER} />
              ) : (
                <section className="card terminal" role="status">
                  <h2>Live runs are paused on this deployment</h2>
                  <p>You are past the gate, but this deployment is not taking live runs right now. <Link href="/runs">The recorded runs</Link> and <Link href="/finder">the finder&apos;s before and after</Link> still play, with real ids from real sandbox runs.</p>
                </section>
              )}
            </div>
            <aside className="card limits-card" aria-labelledby="limits-h">
              <h2 id="limits-h">Hosted limits</h2>
              <dl className="facts">
                <dt>Per step</dt><dd>{usd(HOSTED_CAPS.maxStepAmountMinor)}</dd>
                <dt>Per run</dt><dd>{usd(HOSTED_CAPS.maxTotalMinor)}</dd>
                <dt>Steps</dt><dd>{HOSTED_CAPS.maxSteps}</dd>
                <dt>Disputes</dt><dd>{HOSTED_CAPS.maxDisputes}, from the bank</dd>
                <dt>Worst-case time</dt><dd>{TIME_BUDGET_S} s</dd>
                <dt>Live runs a day</dt><dd>{HOSTED_RUN_LIMITS.global}, {HOSTED_RUN_LIMITS.session} per session</dd>
                <dt>Planner calls a day</dt><dd>{HOSTED_MODEL_LIMITS.global}, {HOSTED_MODEL_LIMITS.session} per session</dd>
                <dt>At once</dt><dd>one run</dd>
              </dl>
            </aside>
          </div>
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
