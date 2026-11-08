"use client";

import { useEffect, useMemo, useState } from "react";
import { type HostedReplay, hostedEndS, hostedRead } from "../lib/hostedReplays";
import { type ReplayRun as Recorded, replayEndS, replayRead } from "../lib/replays";
import { dur, runStory } from "../lib/runStory";
import { RunView } from "./RunView";

/**
 * A recorded run, played back on its own clock through the live run's own
 * view: the same events a live run writes are rebuilt from the fixture, and
 * the replay clock decides which of them have happened yet. A hosted run
 * needs no rebuilding: its own rows are cut at the replay clock.
 */

export type Replayed = { readonly kind: "fixture"; readonly run: Recorded } | { readonly kind: "hosted"; readonly run: HostedReplay };

const SPEEDS = [1, 8, 32] as const;
type Speed = (typeof SPEEDS)[number];

export function ReplayRun({ replay }: { replay: Replayed }) {
  const end = useMemo(() => (replay.kind === "hosted" ? hostedEndS(replay.run) : replayEndS(replay.run)), [replay]);
  // Server render and first paint show the final state, so the page reads
  // whole before any script runs; the replay then plays from the start.
  const [t, setT] = useState(end);
  const [playing, setPlaying] = useState(false);
  // A hosted run plays at its own pace by default: its calls take a second or two each.
  const [speed, setSpeed] = useState<Speed>(replay.kind === "hosted" ? 1 : 8);

  useEffect(() => {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    setT(0);
    setPlaying(true);
  }, [end]);

  useEffect(() => {
    if (!playing) return;
    let last = performance.now();
    let frame = requestAnimationFrame(function tick(now) {
      const dt = (now - last) / 1000;
      last = now;
      setT((prev) => {
        const next = Math.min(end, prev + dt * speed);
        if (next >= end) setPlaying(false);
        return next;
      });
      frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
  }, [playing, speed, end]);

  // Whole tenths only, so the story is rebuilt when the clock moves, not every
  // frame; the end itself is exact, or the last tenth would never reach it.
  const at = t >= end ? end : Math.floor(t * 10) / 10;
  const story = useMemo(() => runStory(replay.kind === "hosted" ? hostedRead(replay.run, at) : replayRead(replay.run, at)), [replay, at]);
  const done = t >= end;

  const controls = (
    <div className="controls" role="group" aria-label="Replay controls">
      <span className="clock" aria-live="off">Recorded clock <span className="mono">{dur(t)}</span> of <span className="mono">{dur(end)}</span></span>
      <button type="button" className="btn btn-quiet" onClick={() => { if (done) setT(0); setPlaying((p) => !p || done); }}>
        {playing ? "Pause" : done ? "Replay from the start" : "Play"}
      </button>
      <span className="seg" role="radiogroup" aria-label="Replay speed">
        {SPEEDS.map((s) => (
          <button key={s} type="button" role="radio" aria-checked={speed === s} onClick={() => setSpeed(s)}>{s}x</button>
        ))}
      </span>
      <button type="button" className="btn btn-quiet" onClick={() => { setPlaying(false); setT(end); }} disabled={done}>Show the end</button>
    </div>
  );

  if (replay.kind === "hosted") {
    return <RunView story={story} name={replay.run.title} runId={replay.run.runId} mode="replay" controls={controls} />;
  }
  const run = replay.run;
  return (
    <RunView
      story={story}
      name={run.scenarioName}
      runId={run.runId}
      mode="replay"
      controls={controls}
    />
  );
}
