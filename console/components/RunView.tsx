"use client";

import { useState } from "react";
import { type Reply, type RunStory, type StepCard, arrivalWord, dur } from "../lib/runStory";
import { Badge, Icon, Mark, type MarkKind } from "./chrome";

/**
 * One run, live or replayed, drawn from a RunStory. The live page and the
 * replay page both render this, so a judge without a passcode sees exactly
 * what a live run looks like. Answer first, then the proof, then one card per
 * step with what Rehearsal sent and what PayPal sent back on the same row.
 */

export type Finding = {
  readonly classId: string;
  readonly verdict: "bug" | "ok" | "inconclusive";
  readonly title: string;
  readonly expected: string;
  readonly actual: string;
  readonly likelyFix: string;
  readonly skipped: string | null;
};

type Props = {
  readonly story: RunStory;
  readonly name: string;
  readonly runId: string;
  readonly mode: "live" | "replay";
  readonly controls?: React.ReactNode;
  readonly finding?: Finding | null;
  readonly verdictLine?: { readonly kind: "ok" | "bug"; readonly text: string } | null;
  readonly aside?: React.ReactNode;
};

const TONE_BADGE: Record<RunStory["tone"], { kind: MarkKind; word: (s: RunStory) => string }> = {
  queued: { kind: "stop", word: () => "Queued" },
  running: { kind: "wait", word: (s) => (s.progress === null ? "Running" : `Step ${s.progress.at} of ${s.progress.of}`) },
  waiting: { kind: "wait", word: (s) => `Waiting on ${s.proof.filter((p) => !p.arrived).length}` },
  done: { kind: "ok", word: () => "Done" },
  stopped: { kind: "bug", word: () => "Stopped" },
};

export function RunView({ story, name, runId, mode, controls, finding, verdictLine, aside }: Props) {
  const tb = TONE_BADGE[story.tone];
  return (
    <div className={`run tone-${story.tone}`}>
      <section className="hero run-hero" aria-labelledby="run-h">
        <div className="wrap hero-grid">
          <div className="answer" aria-live="polite">
            <p className="eyebrow">
              <b>{name}</b>
              <span>Run <span className="mono">{runId}</span></span>
              <span className={`hero-badge ${tb.kind}`}><Icon name={tb.kind === "ok" ? "check" : tb.kind === "bug" ? "cross" : tb.kind === "wait" ? "clock" : "dash"} />{tb.word(story)}</span>
            </p>
            <h1 id="run-h">{story.headline}</h1>
            {story.lead !== null && <p className="lead">{story.lead}</p>}
            {story.progress !== null && <Progress at={story.progress.at} of={story.progress.of} live={!story.settled} />}
            {controls}
          </div>
          <ProofPanel story={story} />
        </div>
      </section>

      <div className="wrap">
        <dl className="card figures lift" aria-label="Summary">
          <div><dt>Steps</dt><dd>{story.figures.steps}</dd></div>
          <div><dt>Amount in calls</dt><dd><span>{story.figures.amount}{story.figures.amountNote !== null && <small>{story.figures.amountNote}</small>}</span></dd></div>
          <div><dt>Slowest reply</dt><dd>{story.figures.slowest}</dd></div>
          <div>
            <dt>Signatures</dt>
            <dd>
              {story.figures.signaturesOk === true && <Icon name="check" className="icon ok-fill" />}
              {story.figures.signaturesOk === false && <Icon name="cross" className="icon bug-fill" />}
              {story.figures.signatures}
            </dd>
          </div>
        </dl>

        {story.notes.length > 0 && (
          <div className="notes" role="status">
            {story.notes.map((n) => <p key={n}><Mark kind="wait">{n}</Mark></p>)}
          </div>
        )}

        <div className="section-head">
          <h2 id="steps-h">Steps</h2>
          <p>What Rehearsal sent, and what PayPal replied</p>
        </div>
        {story.cards.length === 0 ? (
          <p className="note">{story.settled ? "No step ran." : "No step has started yet."}</p>
        ) : (
          <ol className="steps" aria-labelledby="steps-h">
            {story.cards.map((c) => <Step key={c.id} card={c} mode={mode} settled={story.settled} />)}
          </ol>
        )}

        {story.other.length > 0 && (
          <section className="other" aria-labelledby="other-h">
            <h2 id="other-h">Other events PayPal sent</h2>
            <p className="note">Recorded by the store while this run was going, but not tied to any one step by an id. They are listed, never matched by guess.</p>
            <ul className="card">
              {story.other.map((o) => (
                <li key={o.eventId}>
                  <span className="o-plain">{o.plain}</span>
                  <span className="o-meta">
                    {o.atS !== null && <>after {dur(o.atS)} · </>}
                    {o.copies} {o.copies === 1 ? "copy" : "copies"} · <span className="mono">{o.eventType ?? "type not given"}</span> · <span className="mono">{o.eventId}</span>
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {verdictLine !== undefined && verdictLine !== null && (
          <section className="card verdict-card" aria-labelledby="verdict-h">
            <h2 id="verdict-h">Finder verdict</h2>
            <p><Badge kind={verdictLine.kind}>{verdictLine.kind === "bug" ? "BUG" : "OK"}</Badge> {verdictLine.text}</p>
          </section>
        )}
        {finding !== undefined && finding !== null && <FindingCard finding={finding} />}
        {aside}
      </div>
    </div>
  );
}

function Progress({ at, of, live }: { at: number; of: number; live: boolean }) {
  return (
    <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={of} aria-valuenow={at} aria-label={`Step ${at} of ${of}`}>
      <span className="progress-word">Step {at} of {of}</span>
      <span className="progress-track" aria-hidden="true">
        {Array.from({ length: of }, (_, i) => (
          <span key={i} className={`seg-bit${i < at - 1 ? " done" : i === at - 1 ? (live ? " now" : " done") : ""}`} />
        ))}
      </span>
    </div>
  );
}

function ProofPanel({ story }: { story: RunStory }) {
  return (
    <aside className="proof" aria-labelledby="proof-h">
      <div className="proof-head">
        <h2 id="proof-h">Proof from PayPal</h2>
        <span>in the order it arrived</span>
      </div>
      {story.proof.length === 0 ? (
        story.settled ? null : <p className="proof-empty">Each event PayPal sends lands here, verified, in arrival order.</p>
      ) : (
        <ol className="nodes">
          {story.proof.map((p) => (
            <li key={p.key} className={p.arrived ? "in" : "out"}>
              <span className="node" aria-hidden="true">{p.arrived ? <Icon name="check" /> : <Icon name="clock" />}</span>
              <span className="node-label">{p.label}</span>
              <span className="node-meta">{p.arrived ? (p.early ? "during the step" : p.latencyS === null ? "arrived" : `${p.exact ? "" : "at most "}${dur(p.latencyS)}`) : story.settled ? "not seen" : "waiting"}</span>
            </li>
          ))}
        </ol>
      )}
      <p className="proof-line">{story.proofLine}</p>
    </aside>
  );
}

/** The left rail's dot: an icon, so a step's state never rests on color. */
function railOf(c: StepCard): { cls: string; icon: "check" | "cross" | "clock" | "dot" | "dash"; word: string } {
  if (c.sent === "refused" || c.sent === "not-sent" || c.sent === "unknown" || c.sent === "never-confirmed") return { cls: "bug", icon: "cross", word: c.sentWord };
  if (c.current) return { cls: "now", icon: "dot", word: "In progress" };
  if (c.sent === "accepted" && (c.reply === "delivered" || c.reply === "none-expected")) return { cls: c.reply === "delivered" ? "ok" : "ok-quiet", icon: "check", word: "Done" };
  if (c.sent === "accepted" && c.reply === "not-seen") return { cls: "quiet", icon: "dash", word: "Reply not seen" };
  if (c.sent === "accepted") return { cls: "now", icon: "clock", word: "Waiting" };
  return { cls: "quiet", icon: "dash", word: "Not started" };
}

function Step({ card: c, mode, settled }: { card: StepCard; mode: "live" | "replay"; settled: boolean }) {
  const rail = railOf(c);
  const compact = c.sent === "not-run" || (c.reply === "none-expected" && (c.sent === "accepted" || c.sent === "queued"));
  const failed = c.sent === "refused" || c.sent === "not-sent" || c.sent === "unknown" || c.sent === "never-confirmed";
  return (
    <li className={`step${c.current ? " current" : ""}${compact ? " compact" : ""}${failed ? " failed" : ""} s-${c.sent} r-${c.reply}`} data-step={c.id}>
      <span className={`rail ${rail.cls}`}><Icon name={rail.icon} /><span className="sr">{rail.word}</span></span>
      <article className="card step-card" aria-label={`Step ${c.n}: ${c.title}`}>
        {compact ? (
          <div className="row-compact">
            <span className="step-n">Step {c.n}</span>
            <span className="compact-title">{c.title}{c.amount !== null && <>, {c.amount}</>}</span>
            <span className="compact-state">{c.sent === "queued" ? <Mark kind="stop">Queued</Mark> : c.sent === "not-run" ? <Mark kind="stop">Not run</Mark> : null}</span>
            <span className="compact-note">{c.sent === "not-run" ? "The run stopped before this step, so it was never sent." : "No PayPal event is tied to this kind of step."}</span>
          </div>
        ) : (
          <div className="row">
            <div className="sent">
              <p className="step-n">Step {c.n}, {c.sent === "queued" ? "Rehearsal will send" : c.sent === "not-sent" ? "not sent" : "Rehearsal sent"}</p>
              <p className="sent-title">{c.title}</p>
              {c.amount !== null && <p className="sent-amount">{c.amount}</p>}
              <p className="sent-state"><SentMark card={c} /></p>
            </div>
            <Middle card={c} />
            <div className="back">
              <Back card={c} mode={mode} settled={settled} />
            </div>
          </div>
        )}
        {failed && c.problem !== null && <p className="problem"><Icon name="cross" className="icon bug-fill" />{c.problem}</p>}
        <details className="details">
          <summary>
            <span className="foot-note">{c.reply === "waiting" && !failed ? (mode === "live" ? "It shows here the moment the store records it. The run listens for 90 s after its last step." : "Shown on the run's recorded clock.") : ""}</span>
            <span className="details-toggle">Details <Icon name="chevron" /></span>
          </summary>
          <Details card={c} />
        </details>
      </article>
    </li>
  );
}

function SentMark({ card: c }: { card: StepCard }) {
  switch (c.sent) {
    case "queued":
      return <Mark kind="stop">Queued</Mark>;
    case "sending":
      return <span className="mark wait sending"><span className="pulse" aria-hidden="true" />Sending to PayPal</span>;
    case "accepted":
      return <Mark kind="ok">PayPal accepted</Mark>;
    default:
      return <Mark kind="bug">{c.sentWord}</Mark>;
  }
}

/** The reply pill and the short connector between what was sent and what came back. */
function Middle({ card: c }: { card: StepCard }) {
  const last = c.replies.filter((r) => r.latencyS !== null);
  const slowest = last.length === 0 ? null : last.reduce((a, b) => ((b.latencyS ?? 0) > (a.latencyS ?? 0) ? b : a));
  if (c.reply === "delivered" && slowest === null) {
    return (
      <div className="mid done">
        <span className="pill"><Icon name="clock" />Arrived during the step</span>
        <span className="conn" aria-hidden="true" />
        <span className="mid-note">while it was still checking with PayPal</span>
      </div>
    );
  }
  if (c.reply === "delivered" && slowest !== null) {
    const ranks = c.replies.flatMap((r) => (r.rank === null ? [] : [r.rank]));
    return (
      <div className="mid done">
        <span className="pill"><Icon name="clock" />Replied in {dur(slowest.latencyS!)}{slowest.exact ? "" : " at most"}</span>
        <span className="conn" aria-hidden="true" />
        <span className="mid-note">{ranks.length === 1 ? arrivalWord(ranks[0]!) : `${ranks.map((r) => arrivalWord(r).replace(" to arrive", "")).join(" and ")} to arrive`}</span>
      </div>
    );
  }
  if (c.reply === "waiting" || (c.reply === "not-yet" && c.sent === "accepted")) {
    return (
      <div className="mid waiting">
        <span className="pill wait"><Icon name="clock" />{dur(c.waitingS ?? 0)} so far</span>
        <span className="conn dashed" aria-hidden="true" />
        <span className="mid-note">no reply yet</span>
      </div>
    );
  }
  if (c.reply === "not-seen") {
    return (
      <div className="mid">
        <span className="pill quiet"><Icon name="dash" />Not seen</span>
        <span className="conn quiet" aria-hidden="true" />
        <span className="mid-note">when the wait ended</span>
      </div>
    );
  }
  if (c.sent === "sending") {
    return (
      <div className="mid waiting">
        <span className="pill quiet"><Icon name="arrow" />Calling PayPal</span>
        <span className="conn dashed quiet" aria-hidden="true" />
        <span className="mid-note">reply comes after PayPal accepts</span>
      </div>
    );
  }
  return (
    <div className="mid">
      <span className="conn quiet" aria-hidden="true" />
    </div>
  );
}

function Back({ card: c, mode, settled }: { card: StepCard; mode: "live" | "replay"; settled: boolean }) {
  const failed = c.sent === "refused" || c.sent === "not-sent" || c.sent === "unknown" || c.sent === "never-confirmed";
  if (failed) {
    return (
      <>
        <p className="back-label">PayPal reply</p>
        <p className="back-title">{c.sent === "not-sent" ? "Nothing to wait for" : c.sent === "refused" ? "No event tied to this step" : "Unknown"}</p>
        {c.sent === "refused" && <p className="reply-meta">If PayPal sends one anyway, it is listed under Other events PayPal sent.</p>}
      </>
    );
  }
  if (c.sent === "queued" || c.sent === "sending") {
    return (
      <>
        <p className="back-label">PayPal reply</p>
        <p className="back-title quiet">{c.sent === "queued" ? (settled ? "Never sent" : "Not sent yet") : "Waiting for PayPal to accept"}</p>
      </>
    );
  }
  const arrived = c.replies.filter((r) => r.arrived);
  const pending = c.replies.filter((r) => !r.arrived);
  return (
    <>
      <p className="back-label">{arrived.length > 0 ? "PayPal replied" : "PayPal reply"}</p>
      <ul className="replies">
        {arrived.map((r) => <ReplyLine key={r.key} r={r} many={c.replies.length > 1} />)}
        {(pending.length > 0 || (c.reply === "not-yet" && arrived.length === 0)) && (
          <li className="reply pending">
            {c.reply === "not-seen" ? (
              <>
                <span className="back-title quiet">Not seen when the wait ended</span>
                <span className="reply-meta">Not proof it never came: the sandbox has delivered later than that before.</span>
              </>
            ) : (
              <>
                <span className="back-title">Waiting for PayPal&apos;s webhook</span>
                <Badge kind="wait">Waiting, {dur(c.waitingS ?? 0)} so far{mode === "replay" ? " (recorded)" : ""}</Badge>
              </>
            )}
          </li>
        )}
      </ul>
    </>
  );
}

function ReplyLine({ r, many }: { r: Reply; many: boolean }) {
  return (
    <li className="reply">
      <span className="back-title">{r.plain}</span>
      <span className="reply-meta">
        {r.verified > 0 && r.verified === r.copies ? <Badge kind="ok">Verified</Badge> : <Badge kind="stop">{r.verified} of {r.copies} verified</Badge>}
        {many && r.latencyS !== null && <span>{dur(r.latencyS)}{r.rank !== null ? `, ${arrivalWord(r.rank)}` : ""}</span>}
      </span>
    </li>
  );
}

const utc = (iso: string | null) => (iso === null ? "not recorded" : `${new Date(iso).toISOString().slice(0, 19).replace("T", " ")} UTC`);

function Details({ card: c }: { card: StepCard }) {
  const d = c.details;
  return (
    <div className="details-body">
      <dl className="dl">
        <dt>Step kind</dt><dd className="mono">{d.kind}</dd>
        <dt>Step id</dt><dd className="mono">{c.id}</dd>
        {d.request !== null && <><dt>Request</dt><dd className="mono">{d.request}</dd></>}
        {d.from !== null && <><dt>Acts on</dt><dd className="mono">{d.from}</dd></>}
        {d.ids.map(([k, v]) => (
          <IdRow key={k} name={k} value={v} />
        ))}
        <dt>Started</dt><dd className="mono">{utc(d.startedAt)}</dd>
        <dt>PayPal answered</dt><dd className="mono">{utc(d.acceptedAt)}</dd>
        {d.detail !== null && d.detail !== "" && <><dt>Engine detail</dt><dd className="mono">{d.detail}</dd></>}
        {d.paypalCode !== null && <><dt>PayPal error code</dt><dd className="mono">{d.paypalCode}</dd></>}
      </dl>
      {c.replies.map((r) => (
        <dl key={r.key} className="dl event">
          <dt>Event type</dt><dd className="mono">{r.eventType}{r.redelivery ? " (second delivery)" : ""}</dd>
          {r.eventId !== null && <IdRow name="Event id" value={r.eventId} />}
          <dt>Received</dt><dd className="mono">{r.arrived ? utc(r.receivedAt) : "not yet"}</dd>
          <dt>Signature check</dt><dd>{r.arrived ? (r.verified === r.copies ? `passed: PayPal's verify call said SUCCESS (${r.copies} of ${r.copies} ${r.copies === 1 ? "copy" : "copies"})` : `${r.verified} of ${r.copies} copies passed`) : "not yet"}</dd>
          <dt>Store action</dt><dd className="mono">{r.store ?? "not yet"}</dd>
          <dt>Latency</dt><dd>{r.early ? "the store recorded it before the step finished, while the step was still checking with PayPal" : r.latencyS === null ? "not yet" : r.exact ? `${dur(r.latencyS)}, from the step finishing to the store recording the event` : `at most ${dur(r.latencyS)}: seen when the console read the store`}</dd>
        </dl>
      ))}
      {c.reply === "none-expected" && <p className="note">This console ties no PayPal event to a {d.kind} step. Any event PayPal sends for it is listed under Other events PayPal sent.</p>}
    </div>
  );
}

function IdRow({ name, value }: { name: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <>
      <dt>{name}</dt>
      <dd className="mono id-row">
        <span>{value}</span>
        <button
          type="button"
          className="copy"
          aria-label={`Copy ${name}`}
          onClick={() => {
            void navigator.clipboard?.writeText(value).then(
              () => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              },
              () => setCopied(false),
            );
          }}
        >
          <Icon name={copied ? "check" : "copy"} />
          <span>{copied ? "Copied" : "Copy"}</span>
        </button>
      </dd>
    </>
  );
}

/** The finder's verdict as the lab report gives it: a badge and a word, then the evidence. */
function FindingCard({ finding }: { finding: Finding }) {
  const kind = finding.verdict === "bug" ? "bug" : finding.verdict === "ok" ? "ok" : "stop";
  const word = finding.verdict === "bug" ? "BUG" : finding.verdict === "ok" ? "OK" : "INCONCLUSIVE";
  return (
    <section className="card verdict-card finding" aria-labelledby="finding-h">
      <h2 id="finding-h">Finder verdict <span className="mono">{finding.classId}</span></h2>
      <p className="verdict-line"><Badge kind={kind}>{word}</Badge> {finding.title}</p>
      <dl className="dl">
        <dt>Expected</dt><dd>{finding.expected}</dd>
        <dt>Observed</dt><dd>{finding.actual}</dd>
        <dt>Likely fix</dt><dd>{finding.likelyFix}</dd>
        {finding.skipped !== null && <><dt>Not run</dt><dd>{finding.skipped}</dd></>}
      </dl>
      <p className="note">The verdict comes from the store&apos;s own records of this run&apos;s events. With no such record it says INCONCLUSIVE, never OK.</p>
    </section>
  );
}
