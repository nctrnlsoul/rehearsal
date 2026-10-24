import Link from "next/link";
import { Mark, ReplayBanner, SiteFooter, Topbar } from "../../components/chrome";
import { RUNS, utcTime } from "../../lib/replays";
import "./timeline.css";

export default function RunsPage() {
  return (
    <div className="s-runs">
      <a className="skip" href="#runs">Skip to the runs</a>
      <ReplayBanner>Recorded runs from REHEARSAL&apos;s own sandbox account. Each one replays on its recorded clock; nothing here is live.</ReplayBanner>
      <Topbar current="runs" />
      <header className="page">
        <div>
          <h1>Recorded runs, replayed on their own clock</h1>
          <p className="runline">The same run before and after the store&apos;s one-line fix. Ids, times and store rows are the real ones.</p>
        </div>
      </header>
      <main style={{ display: "block" }}>
        <ul className="run-list" id="runs">
          {RUNS.map((r) => (
            <li key={r.runId}>
              <Link href={`/runs/${r.runId}`}>
                <span className="nm">{r.scenarioName}</span>
                <span className="meta">{r.runId} · {r.startedAt.slice(0, 10)} {utcTime(r.startedAt)} UTC · {r.calls.length} calls · {r.deliveries.length} deliveries</span>
                <span className="v">{r.verdict === "bug" ? <Mark kind="bug">BUG</Mark> : <Mark kind="ok">OK</Mark>}</span>
              </Link>
            </li>
          ))}
        </ul>
      </main>
      <SiteFooter>REHEARSAL · replays · live runs arrive in Stage B</SiteFooter>
    </div>
  );
}
