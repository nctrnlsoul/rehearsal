import Link from "next/link";
import type { CSSProperties } from "react";
import { Badge, Icon, Mark, ReplayBanner, SiteFooter, Topbar } from "../../components/chrome";
import { FINDER, type ReplayRun, runById, utcTime } from "../../lib/replays";
import "./finder.css";

const order = (i: number) => ({ "--i": i }) as CSSProperties;

type Side = typeof FINDER.before;

/** One check, the same for both runs: Expected, Observed and Flag, as a lab report reads. */
type Check = { name: string; expected: string; value: (s: Side) => string; outOfRange: (s: Side) => "high" | "low" | null };

const CHECKS: readonly Check[] = [
  { name: "Deliveries of the resent event", expected: "at least 2: the resend has to arrive", value: (s) => String(s.deliveries), outOfRange: (s) => (s.deliveries < 2 ? "low" : null) },
  { name: "Fulfillments for that event id", expected: "exactly 1, however many deliveries", value: (s) => String(s.fulfilled), outOfRange: (s) => (s.fulfilled > 1 ? "high" : s.fulfilled < 1 ? "low" : null) },
  { name: "Redeliveries recognized and ignored", expected: "every delivery after the first", value: (s) => String(s.ignored), outOfRange: (s) => (s.ignored < s.deliveries - 1 ? "low" : null) },
  { name: "Deliveries verified as PayPal's", expected: "all of them", value: (s) => `${s.verified} of ${s.deliveries}`, outOfRange: (s) => (s.verified < s.deliveries ? "low" : null) },
];

function Flag({ f }: { f: "high" | "low" | null }) {
  return f === null ? <Mark kind="ok">in range</Mark> : <Mark kind="bug">{f === "high" ? "high, a bug" : "low"}</Mark>;
}

function Evidence({ run, side, label }: { run: ReplayRun; side: Side; label: string }) {
  const order0 = run.calls.find((c) => c.kind === "card_order");
  return (
    <article className="card run-ev">
      <div className="plate"><Badge kind={side.verdict === "bug" ? "bug" : "ok"}>{label}</Badge><Link className="mono" href={`/runs/${run.runId}`}>{run.runId}</Link></div>
      <div className="body">
        <dl>
          {order0 !== undefined && (
            <>
              <dt>order</dt><dd>{order0.ids["order"]}</dd>
              <dt>capture</dt><dd>{order0.ids["capture"]} · {order0.what}</dd>
            </>
          )}
          <dt>event</dt><dd>{run.deliveries[0]?.eventId}</dd>
          <dt>report</dt><dd>{side.report}</dd>
        </dl>
        <ol className="rows" aria-label="Store rows for this event">
          {run.deliveries.map((d) => (
            <li key={d.at}>
              <span className="t">{utcTime(d.at)}</span>
              <span>
                <span className={`act${d.store === "fulfilled" && d.repeat ? " twice" : ""}`}>{d.store === "fulfilled" && d.repeat ? "fulfilled again" : d.store}</span>
                <span className="proof">{d.verified ? " · verified" : " · not verified"}{d.certHost !== null ? ` · cert host ${d.certHost}` : ""}</span>
              </span>
            </li>
          ))}
        </ol>
      </div>
    </article>
  );
}

export default function FinderPage() {
  const before = runById(FINDER.before.runId)!;
  const after = runById(FINDER.after.runId)!;
  const bugs = (s: Side) => (s.verdict === "bug" ? 1 : 0);

  return (
    <div className="s-finder">
      <a className="skip" href="#report">Skip to the report</a>
      <Topbar current="finder" />
      <ReplayBanner>A recorded finder pass, before and after the fix: runs, ids, counts and the change are real. Nothing here is live.</ReplayBanner>
      <main>
      <section className="hero" aria-labelledby="finder-h">
        <div className="wrap">
          <p className="eyebrow">Finder report · {FINDER.classId}</p>
          <h1 id="finder-h">The finder caught a real bug in the sample store, then proved the one-line fix.</h1>
          <p className="lead">Same scenario, same check, run before and after the change. Each verdict rests on the store&apos;s own rows, not on the absence of an error.</p>
        </div>
      </section>
      <div className="wrap lift">
      <section className="card verdicts" aria-label="Verdicts before and after the fix">
        <div className="bug arrive" style={order(0)}>
          <div className="label">Before</div>
          <div className="num">{bugs(FINDER.before)}<small>bug</small></div>
          <Badge kind="bug">BUG</Badge>
          <div className="when"><Link href={`/runs/${before.runId}`}>run {before.runId}</Link> · {before.startedAt.slice(0, 10)} {utcTime(before.startedAt).slice(0, 5)} UTC</div>
        </div>
        <div className="arrow" aria-hidden="true"><Icon name="arrow" /></div>
        <div className="ok arrive" style={order(1)}>
          <div className="label">After</div>
          <div className="num">{bugs(FINDER.after)}<small>bugs</small></div>
          <Badge kind="ok">OK</Badge>
          <div className="when"><Link href={`/runs/${after.runId}`}>run {after.runId}</Link> · {after.startedAt.slice(0, 10)} {utcTime(after.startedAt).slice(0, 5)} UTC</div>
        </div>
      </section>

      <section className="card report arrive" style={order(2)} id="report" aria-labelledby="cls-h">
        <h2>Lab report</h2>
        <p className="cls" id="cls-h">{FINDER.title} <span className="mono">{FINDER.classId} · {FINDER.eventType}</span></p>
        <div className="table-wrap"><table className="lab">
          <thead>
            <tr><th>Check</th><th>Expected</th><th>Before<span className="mono">{before.runId.slice(-6)}</span></th><th>Flag</th><th>After<span className="mono">{after.runId.slice(-6)}</span></th><th>Flag</th></tr>
          </thead>
          <tbody>
            {CHECKS.map((c) => {
              const fb = c.outOfRange(FINDER.before);
              const fa = c.outOfRange(FINDER.after);
              return (
                <tr key={c.name}>
                  <td className="check">{c.name}</td>
                  <td className="exp" data-l="Expected">{c.expected}</td>
                  <td className={`obs${fb !== null ? " out" : ""}`} data-l="Before">{c.value(FINDER.before)}</td>
                  <td data-l="Before flag"><Flag f={fb} /></td>
                  <td className={`obs${fa !== null ? " out" : ""}`} data-l="After">{c.value(FINDER.after)}</td>
                  <td data-l="After flag"><Flag f={fa} /></td>
                </tr>
              );
            })}
          </tbody>
        </table></div>
      </section>

      <section className="evidence" aria-label="Evidence: the store's rows for each run">
        <Evidence run={before} side={FINDER.before} label="before the fix" />
        <Evidence run={after} side={FINDER.after} label="after the fix" />
      </section>

      <section className="card fix" aria-labelledby="fix-h">
        <h2 id="fix-h">The change between the two runs</h2>
        <div className="diff" role="img" aria-label={`${FINDER.fix.file} line ${FINDER.fix.line}: DEDUPE_BY_EVENT_ID changed from false to true`}>
          <div className="file">{FINDER.fix.file}:{FINDER.fix.line}</div>
          <div className="del">- {FINDER.fix.removed}</div>
          <div className="add">+ {FINDER.fix.added}</div>
        </div>
        <p className="meta">commit {FINDER.fix.commit} · {FINDER.fix.subject} · merged in PR #{FINDER.fix.pr}</p>
      </section>

      <section className="card rule" aria-labelledby="rule-h">
        <h2 id="rule-h">How a verdict is decided</h2>
        <ol>
          <li><b>BUG</b> only when one event id was fulfilled twice.</li>
          <li><b>OK</b> only when the event was fulfilled once and a redelivery reached the store and was ignored.</li>
          <li>Anything else, including a redelivery PayPal never sent, is <b>INCONCLUSIVE</b>, never OK.</li>
        </ol>
      </section>

      <div className="actions">
        <Link className="btn btn-primary" href="/live">Run duplicate-webhook again</Link>
        <span className="note">A live finder run needs the judge passcode, at /live. These two runs took about 70 seconds and 2 minutes, mostly waiting on PayPal&apos;s redelivery.</span>
      </div>
      </div>
      </main>
      <SiteFooter />
    </div>
  );
}
