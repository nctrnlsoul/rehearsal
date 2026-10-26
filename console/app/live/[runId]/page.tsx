import Link from "next/link";
import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { SiteFooter, Topbar } from "../../../components/chrome";
import { LiveTimeline } from "../../../components/LiveTimeline";
import { RUN_ID_SHAPE } from "../../../lib/liveView";
import { SESSION_COOKIE, hasValidSession } from "../../../lib/session";
import "../../runs/timeline.css";
import "../live.css";

/** Behind the gate, like every live surface. The run itself is read by the page, every 2 s. */
export default async function LiveRunPage({ params }: { params: Promise<{ runId: string }> }) {
  const jar = await cookies();
  if (!hasValidSession(jar.get(SESSION_COOKIE)?.value, process.env, Date.now())) redirect("/gate");
  const { runId } = await params;
  if (!RUN_ID_SHAPE.test(runId)) notFound();

  return (
    <div className="s-runs s-live">
      <a className="skip" href="#timeline">Skip to the run timeline</a>
      <div className="live-banner" role="note"><strong>LIVE</strong><span>Real calls to PayPal&apos;s sandbox, made by this console, as they happen.</span></div>
      <Topbar current="live" />
      <header className="page">
        <div>
          <h1>Live run</h1>
          <p className="runline">Run <span className="mono">{runId}</span></p>
        </div>
      </header>
      <main>
        <div id="timeline"><LiveTimeline runId={runId} /></div>
        <aside aria-label="Run facts">
          <section className="facts-block">
            <h2 className="label">What this run can touch</h2>
            <dl className="facts">
              <dt>PayPal</dt><dd className="word">sandbox only</dd>
              <dt>Events fire at</dt><dd className="word">the sample store only</dd>
              <dt>Webhooks</dt><dd className="word">reuses the store&apos;s, registers none</dd>
              <dt>Retries</dt><dd className="word">none from here</dd>
            </dl>
          </section>
          <section className="facts-block">
            <h2 className="label">How it is read</h2>
            <p className="note">The server saves the run after every step. This page reads that record every 2 s. A delivery shows when the store&apos;s state endpoint reports it, at the time the store recorded receiving it, so a latency is exact to the second. A store that does not report that time shows when it was seen instead, marked &ldquo;within&rdquo;.</p>
          </section>
          <section className="facts-block">
            <p><Link href="/build">Back to the builder</Link></p>
          </section>
        </aside>
      </main>
      <SiteFooter>REHEARSAL · live run · every id is from PayPal&apos;s sandbox</SiteFooter>
    </div>
  );
}
