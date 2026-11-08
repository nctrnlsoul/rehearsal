import Link from "next/link";
import { notFound } from "next/navigation";
import { ReplayBanner, SiteFooter, Topbar } from "../../../components/chrome";
import { ReplayRun } from "../../../components/ReplayRun";
import { hostedById } from "../../../lib/hostedReplays";
import { RUNS, runById } from "../../../lib/replays";
import "../run.css";

/** Only recorded run ids resolve; anything else is a 404, never a guess. */
export default async function RunPage({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  const hosted = hostedById(runId);
  if (hosted !== undefined) {
    return (
      <div className="s-replay">
        <a className="skip" href="#run-h">Skip to the run</a>
        <Topbar current="runs" />
        <ReplayBanner>Hosted live run from {hosted.record.run.created_at.slice(0, 10)}, played on its recorded clock by the same view a live run uses. Nothing here is live.</ReplayBanner>
        <main>
          <ReplayRun replay={{ kind: "hosted", run: hosted }} />
          <div className="wrap">
            <details className="card how">
              <summary>Where this replay comes from</summary>
              <ul className="sources">
                <li>{hosted.evidence}</li>
              </ul>
              <p>The run row and every event it wrote, exported unchanged from this console&apos;s database. The replay shows, at each moment of the recorded clock, the events written by then, as the live page would have seen them; the run row reads as running, with its finish time and final state held back, until its recorded finish. Ids and times are the real ones. Latencies run from PayPal accepting a step to the store recording the event, to the second.</p>
            </details>
          </div>
        </main>
        <SiteFooter />
      </div>
    );
  }
  const run = runById(runId);
  if (run === undefined) notFound();
  const other = RUNS.find((r) => r.runId !== run.runId);

  return (
    <div className="s-replay">
      <a className="skip" href="#run-h">Skip to the run</a>
      <Topbar current="runs" />
      <ReplayBanner>Recorded run from {run.startedAt.slice(0, 10)}, played on its recorded clock by the same view a live run uses. Nothing here is live.</ReplayBanner>
      <main>
        <ReplayRun replay={{ kind: "fixture", run }} />
        <div className="wrap">
          <details className="card how">
            <summary>Where this replay comes from</summary>
            <ul className="sources">
              {run.sources.map((s) => <li key={s}>{s}</li>)}
            </ul>
            <p>The store records events to the second, so latencies are shown to the second. Events went to the sample store&apos;s webhook <span className="mono">4DE52141J0303334X</span>.</p>
          </details>
          {other !== undefined && (
            <p className="note other-run">
              {run.verdict === "bug" ? "After the store's one-line fix: " : "Before the store's one-line fix: "}
              <Link href={`/runs/${other.runId}`}>run <span className="mono">{other.runId}</span></Link>
            </p>
          )}
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
