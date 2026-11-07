import Link from "next/link";
import { Badge, Icon, ReplayBanner, SiteFooter, Topbar } from "../../components/chrome";
import { RUNS, replayEndS } from "../../lib/replays";
import { dur } from "../../lib/runStory";
import "./run.css";

export default function RunsPage() {
  return (
    <div className="s-replay">
      <a className="skip" href="#runs">Skip to the runs</a>
      <Topbar current="runs" />
      <ReplayBanner>Recorded runs from Rehearsal&apos;s own sandbox account, each played on its recorded clock. Nothing here is live.</ReplayBanner>
      <main>
        <section className="hero" aria-labelledby="runs-h">
          <div className="wrap">
            <p className="eyebrow">Replays · no passcode needed</p>
            <h1 id="runs-h">The same run, before and after a one-line fix.</h1>
            <p className="lead">Each replay is drawn by the live run&apos;s own view. Ids, times and the store&apos;s rows are the real ones.</p>
          </div>
        </section>
        <div className="wrap lift">
          <ul className="run-cards" id="runs">
            {RUNS.map((r) => (
              <li key={r.runId}>
                <Link className="card run-card" href={`/runs/${r.runId}`}>
                  <span className="rc-top">
                    <Badge kind={r.verdict}>{r.verdict === "bug" ? "BUG found" : "OK after the fix"}</Badge>
                    <span className="note">{r.startedAt.slice(0, 10)}</span>
                  </span>
                  <span className="rc-name">{r.scenarioName}</span>
                  <span className="rc-line">{r.verdictLine.replace(/^(BUG|OK): /, "")}</span>
                  <span className="rc-meta">
                    {r.calls.length} steps · {r.deliveries.length} deliveries from PayPal · {dur(replayEndS(r))} · <span className="mono">{r.runId}</span>
                  </span>
                  <span className="rc-go">Watch the replay <Icon name="arrow" /></span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
