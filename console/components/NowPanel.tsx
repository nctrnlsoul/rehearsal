"use client";

import { type ReactNode, useLayoutEffect, useRef, useState } from "react";
import type { Chip, NowPanel, PanelBody, Stage } from "../lib/nowPanel";
import { Icon } from "./chrome";

/**
 * The one boxed panel that shows what a run is doing now. Fixed height, so
 * nothing below it moves when its content swaps; sticky only while the run
 * can still change. When the content's key changes (a new step, the wait,
 * the end), the old content fades and slides out while the new fades in.
 */
export function NowPanelBox({ panel }: { panel: NowPanel }) {
  const body = <Body body={panel.body} />;
  return (
    <section className={`card now-panel${panel.sticky ? " sticky" : ""} now-${panel.body.kind}`} aria-label="Now running">
      <Bar panel={panel} />
      <Swap swapKey={panel.key}>{body}</Swap>
    </section>
  );
}

const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Keeps the outgoing content on screen for its exit; with reduced motion the swap is instant. */
function Swap({ swapKey, children }: { swapKey: string; children: ReactNode }) {
  const [leaving, setLeaving] = useState<{ key: string; node: ReactNode } | null>(null);
  const shown = useRef<{ key: string; node: ReactNode }>({ key: swapKey, node: children });
  const [entered, setEntered] = useState(false);
  useLayoutEffect(() => {
    if (shown.current.key !== swapKey) {
      if (!reducedMotion()) {
        setLeaving({ key: shown.current.key, node: shown.current.node });
        setEntered(true);
      }
    }
    shown.current = { key: swapKey, node: children };
  });
  return (
    <div className="np-swap">
      {leaving !== null && (
        <div
          key={`out:${leaving.key}`}
          className="np-body np-leave"
          aria-hidden="true"
          onAnimationEnd={(e) => {
            if (e.target === e.currentTarget) setLeaving(null);
          }}
        >
          {leaving.node}
        </div>
      )}
      {/* The first content does not animate in: the page reads whole on first paint. */}
      <div key={`in:${swapKey}`} className={`np-body${entered ? " np-enter" : ""}`}>
        {children}
      </div>
    </div>
  );
}

function Bar({ panel }: { panel: NowPanel }) {
  return (
    <div className="np-bar">
      <span className="np-track" aria-hidden="true">
        {panel.segments.map((s) => (
          <span key={s.n} className={`np-seg${s.failed ? " failed" : ""}${s.sent && !s.expects ? " whole" : ""}`}>
            <span className={`np-half sent${s.sent ? " on" : ""}`} />
            <span className={`np-half confirmed${s.confirmed ? " on" : ""}`} />
          </span>
        ))}
      </span>
      <span className="np-label">{panel.label}</span>
    </div>
  );
}

function Body({ body }: { body: PanelBody }) {
  switch (body.kind) {
    case "queued":
      return (
        <div className="np-content">
          <p className="np-eyebrow">Not started</p>
          <p className="np-main">{body.title}</p>
          <p className="np-text">{body.text}</p>
        </div>
      );
    case "step":
      return (
        <div className="np-content">
          <p className="np-eyebrow">Step {body.at} of {body.of}</p>
          <p className="np-main">{body.activity}</p>
          <ol className="np-stages">
            {body.stages.map((s) => <StageItem key={s.short} stage={s} />)}
          </ol>
        </div>
      );
    case "webhooks":
      return (
        <div className="np-content">
          <p className="np-eyebrow">Every call is done</p>
          <p className="np-main np-main-sm">{body.title}</p>
          <Chips chips={body.chips} />
          {body.text !== null && <p className="np-text">{body.text}</p>}
        </div>
      );
    case "final":
      return (
        <div className="np-content">
          <p className={`np-eyebrow ${body.tone === "done" ? "ok" : "bug"}`}>
            <Icon name={body.tone === "done" ? "check" : "cross"} />
            {body.tone === "done" ? "Finished" : "Stopped"}
          </p>
          {/* Finished: the answer is one sentence, "All 5 steps done. 4 of 4 webhooks verified." */}
          <p className="np-main np-main-sm">{body.tone === "done" && body.text !== null ? `${body.title} ${body.text}` : body.title}</p>
          {body.tone === "stopped" && body.text !== null && <p className="np-text">{body.text}</p>}
          {body.note !== null && <p className="np-text">{body.note}</p>}
          {body.chips.length > 0 && <Chips chips={body.chips} />}
        </div>
      );
  }
}

const STAGE_WORD: Record<Stage["state"], string> = { done: "done", now: "in progress", todo: "not yet", none: "not applicable", bad: "did not happen" };

function StageItem({ stage: s }: { stage: Stage }) {
  return (
    <li className={`np-stage-item ${s.state}`}>
      <span className="np-dot" aria-hidden="true">
        {s.state === "done" ? <Icon name="check" /> : s.state === "bad" ? <Icon name="cross" /> : s.state === "none" ? <Icon name="dash" /> : null}
      </span>
      <span className="np-stage-label">
        <span className="np-long">{s.label}</span>
        <span className="np-short" aria-hidden="true">{s.short}</span>
        <span className="sr">, {STAGE_WORD[s.state]}</span>
      </span>
    </li>
  );
}

function Chips({ chips }: { chips: readonly Chip[] }) {
  return (
    <ul className="np-chips">
      {chips.map((c) => (
        <li key={c.key} className={`np-chip ${c.state}`}>
          <Icon name={c.state === "in" ? "check" : c.state === "bad" ? "cross" : "clock"} />
          {c.label}
          <span className="sr">{c.state === "in" ? ", verified" : c.state === "bad" ? ", arrived but not verified" : ", not arrived yet"}</span>
        </li>
      ))}
    </ul>
  );
}
