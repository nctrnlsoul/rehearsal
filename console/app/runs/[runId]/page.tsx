import { notFound } from "next/navigation";
import { ReplayBanner, SiteFooter, Topbar } from "../../../components/chrome";
import { ReplayTimeline } from "../../../components/ReplayTimeline";
import { RUNS, runById, utcTime } from "../../../lib/replays";
import "../timeline.css";

/** Only recorded run ids resolve; anything else is a 404, never a guess. */
export default async function RunPage({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  const run = runById(runId);
  if (run === undefined) notFound();

  const verified = run.deliveries.filter((d) => d.verified).length;
  const other = RUNS.find((r) => r.runId !== run.runId);

  return (
    <div className="s-runs">
      <a className="skip" href="#timeline">Skip to the run timeline</a>
      <ReplayBanner>Recorded run {run.runId}, {run.startedAt.slice(0, 10)}. Replayed on its recorded clock; nothing here is live.</ReplayBanner>
      <Topbar current="runs" />
      <header className="page">
        <div>
          <h1>{run.scenarioName}</h1>
          <p className="runline">
            Run <span className="mono">{run.runId}</span> · started <span className="mono">{utcTime(run.startedAt)} UTC</span> · {run.calls.length} calls · {run.deliveries.length} deliveries
          </p>
        </div>
      </header>
      <main>
        <div id="timeline"><ReplayTimeline run={run} /></div>
        <aside aria-label="Run facts">
          <section className="facts-block">
            <h2 className="label">Deliveries verified</h2>
            <dl className="facts">
              <dt>Verified as PayPal&apos;s</dt><dd>{verified} of {run.deliveries.length}</dd>
              <dt>Event target</dt><dd className="word">sample store only</dd>
              <dt>Webhook</dt><dd>4DE52141J0303334X</dd>
            </dl>
          </section>
          <section className="facts-block">
            <h2 className="label">Where this replay comes from</h2>
            <ul className="sources">
              {run.sources.map((s) => <li key={s}>{s}</li>)}
            </ul>
            <p className="note" style={{ marginTop: 8 }}>The store records deliveries to the second, so latencies are shown to the second.</p>
          </section>
          {other !== undefined && (
            <section className="facts-block">
              <h2 className="label">{run.verdict === "bug" ? "After the fix" : "Before the fix"}</h2>
              <p><a href={`/runs/${other.runId}`}>{other.runId}</a></p>
            </section>
          )}
        </aside>
      </main>
      <SiteFooter>REHEARSAL · replay of a recorded run · every id and time is from the run&apos;s own records</SiteFooter>
    </div>
  );
}
