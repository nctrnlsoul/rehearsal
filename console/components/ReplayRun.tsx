"use client";

import { useEffect, useMemo, useState } from "react";
import { type ReplayRun as Recorded, replayEndS, replayRead } from "../lib/replays";
import { dur, runStory } from "../lib/runStory";
import { RunView } from "./RunView";

/**
 * A recorded run, played back on its own clock through the live run's own
 * view: the same events a live run writes are rebuilt from the fixture, and
 * the replay clock decides which of them have happened yet.
 */

const SPEEDS = [1, 8, 32] as const;
type Speed = (typeof SPEEDS)[number];

export function ReplayRun({ run }: { run: Recorded }) {
  const end = useMemo(() => replayEndS(run), [run]);
  // Server render and first paint show the final state, so the page reads
  // whole before any script runs; the replay then plays from the start.
  const [t, setT] = useState(end);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<Speed>(8);

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
  const story = useMemo(() => runStory(replayRead(run, at)), [run, at]);
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

  return (
    <RunView
      story={story}
      name={run.scenarioName}
      runId={run.runId}
      mode="replay"
      controls={controls}
      verdictLine={done ? { kind: run.verdict, text: run.verdictLine.replace(/^(BUG|OK): (.)/, (_m, _v, c: string) => c.toUpperCase()) } : null}
    />
  );
}
