import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { LiveBanner, SiteFooter, Topbar } from "../../../components/chrome";
import { LiveRun } from "../../../components/LiveRun";
import { HOSTED_FINDER } from "../../../lib/hosted";
import { RUN_ID_SHAPE } from "../../../lib/liveView";
import { RECORDED_PLANS } from "../../../components/StartHere";
import { SESSION_COOKIE, hasValidSession } from "../../../lib/session";
import "../../runs/run.css";
import "../live.css";

/** Behind the gate, like every live surface. The run itself is read by the page, every 2 s. */
export default async function LiveRunPage({ params }: { params: Promise<{ runId: string }> }) {
  const jar = await cookies();
  if (!hasValidSession(jar.get(SESSION_COOKIE)?.value, process.env, Date.now())) redirect("/gate");
  const { runId } = await params;
  if (!RUN_ID_SHAPE.test(runId)) notFound();
  const names: Record<string, string> = {
    ...Object.fromEntries(RECORDED_PLANS.map((p) => [p.plan, p.name])),
    ...Object.fromEntries(HOSTED_FINDER.map((c) => [c.id, `Finder: ${c.title}`])),
  };

  return (
    <div className="s-live">
      <a className="skip" href="#run-h">Skip to the run</a>
      <Topbar current="live" />
      <LiveBanner>Real calls to PayPal&apos;s sandbox, made by this console, shown as they happen.</LiveBanner>
      <main>
        <LiveRun runId={runId} names={names} />
        <div className="wrap">
          <details className="card how">
            <summary>How this page reads the run</summary>
            <p>The server saves the run after every step, and this page reads that record every 2 s. An event from PayPal shows when the sample store&apos;s state endpoint reports it, at the time the store recorded receiving it, so a latency is exact to the second. A store that does not report that time shows when it was seen instead, marked &ldquo;at most&rdquo;.</p>
            <p>This run can touch PayPal&apos;s sandbox only. Its events go to the sample store&apos;s webhook, which it reuses and never registers. Nothing here retries a step.</p>
          </details>
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
