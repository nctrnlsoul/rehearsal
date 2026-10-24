"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  AXIS_BREAK_S,
  type ReplayRun,
  type TimelineRow,
  clock,
  gapHeightPx,
  latencyLabel,
  timelineRows,
  utcTime,
} from "../lib/replays";

/**
 * A recorded run, played back on its own clock. Every row is laid out from the
 * start (future rows reserve their space, invisible), so connectors are
 * measured once and nothing shifts as the replay plays. Between PayPal
 * accepting a call and the store recording its delivery, the slot shows the
 * honest waiting state, exactly as long as it lasted, divided by the speed.
 */

const SPEEDS = [1, 8, 32] as const;
type Speed = (typeof SPEEDS)[number];

type Anchor = { x: number; y: number };
type Geometry = { width: number; height: number; narrow: boolean; laneLeft: number; laneRight: number; anchors: Record<string, Anchor>; breaks: number[] };

const keyOf = (row: TimelineRow) => (row.kind === "call" ? `c:${row.call.step}` : `d:${row.delivery.pair}`);

export function ReplayTimeline({ run }: { run: ReplayRun }) {
  const rows = useMemo(() => timelineRows(run), [run]);
  const end = rows[rows.length - 1]!.t;
  const callT = useMemo(() => new Map(rows.filter((r) => r.kind === "call").map((r) => [r.kind === "call" ? r.call.step : "", r.t])), [rows]);

  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<Speed>(8);
  const [geo, setGeo] = useState<Geometry | null>(null);
  const board = useRef<HTMLDivElement>(null);

  // Reduced motion opens on the final state; otherwise the replay plays from the start.
  useEffect(() => {
    const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (still) setT(end);
    else setPlaying(true);
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

  // Measured from the laid-out rows, ignoring entrance transforms (offsetTop).
  const measure = useCallback(() => {
    const b = board.current;
    if (b === null) return;
    const narrow = matchMedia("(max-width: 860px)").matches;
    const anchors: Record<string, Anchor> = {};
    let laneLeft = 0;
    let laneRight = 0;
    const lane = b.querySelector<HTMLElement>("[data-lane]");
    if (lane !== null) {
      laneLeft = lane.offsetLeft + 2;
      laneRight = lane.offsetLeft + lane.offsetWidth - 2;
    }
    for (const el of b.querySelectorAll<HTMLElement>("[data-row]")) {
      anchors[el.dataset.row!] = { x: 0, y: el.offsetTop + 14 };
    }
    const breaks = [...b.querySelectorAll<HTMLElement>("[data-gap]")]
      .filter((g) => Number(g.dataset.gap) >= AXIS_BREAK_S)
      .map((g) => g.offsetTop + g.offsetHeight / 2);
    setGeo({ width: b.offsetWidth, height: b.offsetHeight, narrow, laneLeft, laneRight, anchors, breaks });
  }, []);

  useLayoutEffect(() => {
    measure();
    void document.fonts?.ready.then(measure);
    // A waiting slot and an arrived card differ in height, so rows move as the
    // replay plays; any size change re-measures.
    const board_ = board.current;
    if (board_ === null || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => measure());
    ro.observe(board_);
    for (const el of board_.querySelectorAll("[data-row]")) ro.observe(el);
    return () => ro.disconnect();
  }, [measure]);

  const visible = (row: TimelineRow) => row.t <= t;
  const pairs = rows.filter((r): r is Extract<TimelineRow, { kind: "delivery" }> => r.kind === "delivery");
  const done = t >= end;

  let gridRow = 0;
  const items: React.ReactNode[] = [];
  rows.forEach((row, i) => {
    if (i > 0) {
      const gap = row.t - rows[i - 1]!.t;
      items.push(<div key={`g${i}`} className="gap" data-gap={gap} style={{ gridRow: ++gridRow, height: gapHeightPx(gap) }} />);
    }
    gridRow += 1;
    if (row.kind === "call") {
      const c = row.call;
      items.push(
        <div key={keyOf(row)} data-row={keyOf(row)} className={`call${visible(row) ? " shown" : ""}`} style={{ gridRow }} aria-hidden={!visible(row)}>
          <div className="when">+{clock(row.t)} · {utcTime(c.acceptedAt)} UTC</div>
          <div className="req">{c.request}</div>
          <div className="what">{c.step} · {c.what}</div>
          <div className="ids">{Object.entries(c.ids).map(([k, v]) => `${k} ${v}`).join(" · ")}</div>
          {Date.parse(c.acceptedAt) - Date.parse(c.startedAt) > 10_000 && (
            <div className="why">accepted {Math.round((Date.parse(c.acceptedAt) - Date.parse(c.startedAt)) / 1000)} s after it started: PayPal&apos;s event list had to show the event first</div>
          )}
        </div>,
      );
    } else {
      const d = row.delivery;
      const called = (callT.get(d.pair) ?? Infinity) <= t;
      const arrived = visible(row);
      const waitedS = t - (callT.get(d.pair) ?? t);
      items.push(
        <article key={keyOf(row)} data-row={keyOf(row)} className={`delivery${arrived ? " shown" : called ? " waiting shown" : ""}`} style={{ gridRow }} aria-hidden={!called}>
          {arrived ? (
            <>
              <div className="env-head">
                <span>{d.eventType}{d.repeat ? <span className="tag">2nd delivery</span> : null}</span>
                <span className="when">+{clock(row.t)} · {utcTime(d.at)} UTC</span>
              </div>
              <div className="body">
                <dl>
                  <dt>event</dt><dd>{d.eventId}</dd>
                  <dt>store</dt><dd>{d.store}{d.store === "fulfilled" && d.repeat ? ", a second time" : ""}</dd>
                </dl>
                <div className="proof">
                  {d.verified ? <span className="mark ok"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8.5l3 3 7-7" stroke="currentColor" strokeWidth="2" fill="none" /></svg>verified</span> : null}
                  {d.certHost !== null ? <span className="cert">cert host {d.certHost}</span> : <span className="note">cert host not in our records</span>}
                </div>
                <span className="sr">PayPal took about {latencyLabel(row.latencyS)} to deliver.</span>
              </div>
            </>
          ) : (
            <>
              <div className="env-head"><span>{d.eventType}</span></div>
              <div className="body">
                <span className="mark wait"><svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="2" fill="none" /><path d="M8 4.5V8l2.5 1.5" stroke="currentColor" strokeWidth="2" fill="none" /></svg>waiting on PayPal</span>{" "}
                <span className="mono">{Math.floor(Math.max(0, waitedS))} s</span> so far, in recorded time
              </div>
            </>
          )}
        </article>,
      );
    }
  });

  // Connectors: one per call-delivery pair whose call has happened.
  const links: React.ReactNode[] = [];
  if (geo !== null) {
    if (!geo.narrow) {
      const top = 0;
      const bottom = geo.height - 4;
      links.push(<line key="sl" className="spine" x1={geo.laneLeft} y1={top} x2={geo.laneLeft} y2={bottom} />);
      links.push(<line key="sr" className="spine" x1={geo.laneRight} y1={top} x2={geo.laneRight} y2={bottom} />);
      geo.breaks.forEach((y, i) => {
        for (const x of [geo.laneLeft, geo.laneRight]) {
          links.push(<path key={`b${i}${x}`} className="axis-break" d={`M${x - 5} ${y + 1} L${x + 5} ${y - 3} M${x - 5} ${y + 5} L${x + 5} ${y + 1}`} />);
        }
      });
    }
    let lane = 0;
    for (const p of pairs) {
      const c = geo.anchors[`c:${p.delivery.pair}`];
      const d = geo.anchors[`d:${p.delivery.pair}`];
      const startT = callT.get(p.delivery.pair) ?? Infinity;
      if (c === undefined || d === undefined || startT > t) continue;
      const arrived = p.t <= t;
      const cls = arrived ? "link verified" : "link waiting";
      const label = arrived ? latencyLabel(p.latencyS) : `${Math.floor(t - startT)} s so far`;
      if (!geo.narrow) {
        const x0 = geo.laneLeft;
        const x1 = geo.laneRight;
        const mx = (x0 + x1) / 2;
        const my = (c.y + d.y) / 2;
        const w = label.length * 7.2 + 12;
        links.push(
          <g key={p.delivery.pair}>
            <path className={cls} d={`M${x0} ${c.y} L${x1} ${d.y}`} />
            <circle className="anchor" cx={x0} cy={c.y} r={4} />
            <circle className={`anchor ${arrived ? "ok" : "live"}`} cx={x1} cy={d.y} r={4} />
            <g className={`pill${arrived ? "" : " live"}`}>
              <rect x={mx - w / 2} y={my - 9} width={w} height={18} rx={4} />
              <text x={mx} y={my + 4} textAnchor="middle">{label}</text>
            </g>
          </g>,
        );
      } else {
        const right = 40;
        const x = [33, 20, 7][Math.min(lane++, 2)]!;
        const my = (c.y + d.y) / 2;
        const w = label.length * 7.2 + 12;
        links.push(
          <g key={p.delivery.pair}>
            <path className={cls} d={`M${right} ${c.y} H${x} V${d.y} H${right}`} />
            <circle className="anchor" cx={right} cy={c.y} r={3.5} />
            <circle className={`anchor ${arrived ? "ok" : "live"}`} cx={right} cy={d.y} r={3.5} />
            <g className={`pill${arrived ? "" : " live"}`} transform={`rotate(-90 ${x} ${my})`}>
              <rect x={x - w / 2} y={my - 9} width={w} height={18} rx={4} />
              <text x={x} y={my + 4} textAnchor="middle">{label}</text>
            </g>
          </g>,
        );
      }
    }
  }

  return (
    <section className="timeline" aria-labelledby="tl-h">
      <h2 id="tl-h" className="sr">Run timeline, in time order</h2>
      <div className="controls" role="group" aria-label="Replay controls">
        <span className="clock mono" aria-live="off">replay clock +{clock(t)} of +{clock(end)}</span>
        <button type="button" className="btn btn-quiet" onClick={() => { if (done) setT(0); setPlaying((p) => !p || done); }}>
          {playing ? "Pause" : done ? "Replay from the start" : "Play"}
        </button>
        <span className="speeds" role="radiogroup" aria-label="Replay speed">
          {SPEEDS.map((s) => (
            <button key={s} type="button" role="radio" aria-checked={speed === s} className={`speed${speed === s ? " on" : ""}`} onClick={() => setSpeed(s)}>{s}x</button>
          ))}
        </span>
        <button type="button" className="btn btn-quiet" onClick={() => { setPlaying(false); setT(end); }} disabled={done}>Show the final state</button>
      </div>
      <div className="lanes-head" aria-hidden="true">
        <span className="label">REHEARSAL calls PayPal</span>
        <span className="label mid">PayPal took</span>
        <span className="label">PayPal delivers to the store</span>
      </div>
      <div className="board" ref={board}>
        {/* No viewBox: SVG units are CSS pixels, so a board that grows cannot rescale the drawing. */}
        <svg className="links" aria-hidden="true">{links}</svg>
        {/* Implicit rows: "1 / -1" would end at the explicit grid, so span the real count. */}
        <div className="lane" data-lane="" aria-hidden="true" style={{ gridRow: `1 / span ${gridRow}` }} />
        {items}
      </div>
      <p className="verdict" aria-live="polite">
        {done ? (
          run.verdict === "bug" ? (
            <span className="mark bug"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="2" /></svg>{run.verdictLine}</span>
          ) : (
            <span className="mark ok"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8.5l3 3 7-7" stroke="currentColor" strokeWidth="2" fill="none" /></svg>{run.verdictLine}</span>
          )
        ) : (
          <span className="note">The verdict shows when the replay reaches the end.</span>
        )}
      </p>
    </section>
  );
}
