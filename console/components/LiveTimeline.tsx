"use client";

import Link from "next/link";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { type LiveEvent, type LiveRead, type LiveRunRow, type LiveView, liveView, mergeEvents, withinLabel } from "../lib/liveView";
import { AXIS_BREAK_S, clock, gapHeightPx, utcTime } from "../lib/replays";
import { Mark } from "./chrome";

/**
 * A live run, drawn as it happens, with the replay timeline's lanes and
 * connectors (R-025): every exact call-delivery pair is joined, solid once the
 * delivery is seen, dashed in the accent while it is awaited, with the time on
 * the connector. The connector drawing follows ReplayTimeline's; the two
 * should be merged into one board after judging.
 */

const POLL_MS = 2000;

type Anchor = { y: number };
type Geometry = { height: number; narrow: boolean; laneLeft: number; laneRight: number; anchors: Record<string, Anchor>; breaks: number[] };

type Row =
  | { kind: "call"; key: string; t: number; call: LiveView["calls"][number] }
  | { kind: "delivery"; key: string; t: number; delivery: LiveView["deliveries"][number] }
  | { kind: "waiting"; key: string; t: number; pair: LiveView["pairs"][number] };

type Contact = { kind: "ok" } | { kind: "signed-out" } | { kind: "missing" } | { kind: "lost"; sinceMs: number };

const STATUS_MARK: Record<string, { kind: "ok" | "bug" | "wait" | "stop"; word: string }> = {
  succeeded: { kind: "ok", word: "succeeded" },
  failed: { kind: "bug", word: "failed" },
  unknown: { kind: "stop", word: "unknown: may have written" },
  "in-flight": { kind: "wait", word: "calling PayPal" },
  "never-confirmed": { kind: "stop", word: "never confirmed" },
};

export function LiveTimeline({ runId }: { runId: string }) {
  const [run, setRun] = useState<LiveRunRow | null>(null);
  const [events, setEvents] = useState<LiveEvent[]>([]);
  // The database's clock minus ours, so "so far" counts on the server's time.
  const [offsetMs, setOffsetMs] = useState(0);
  const [contact, setContact] = useState<Contact>({ kind: "ok" });
  const [tick, setTick] = useState(0);
  const lastSeq = useRef(0);

  const view = useMemo(() => {
    if (run === null) return null;
    const read: LiveRead = { run, events, now: new Date(Date.now() + offsetMs).toISOString() };
    return liveView(read);
    // tick is listed so the counters re-derive once a second.
  }, [run, events, offsetMs, tick]);

  const settled = view?.settled ?? false;

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const res = await fetch(`/api/runs/${encodeURIComponent(runId)}?after=${lastSeq.current}`, { cache: "no-store", credentials: "same-origin" });
        if (res.status === 401) return setContact({ kind: "signed-out" });
        if (res.status === 404) return setContact({ kind: "missing" });
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as LiveRead;
        setOffsetMs(Date.parse(body.now) - Date.now());
        setRun(body.run);
        if (body.events.length > 0) {
          lastSeq.current = body.events[body.events.length - 1]!.seq;
          setEvents((held) => mergeEvents(held, body.events));
        }
        setContact({ kind: "ok" });
        const done = ["complete", "halted", "abandoned", "failed"].includes(body.run.status);
        // A full page means more events are waiting; read them at once.
        if (!stopped && (!done || body.events.length === 200)) timer = setTimeout(poll, body.events.length === 200 ? 0 : POLL_MS);
      } catch {
        setContact((c) => (c.kind === "lost" ? c : { kind: "lost", sinceMs: Date.now() }));
        if (!stopped) timer = setTimeout(poll, POLL_MS);
      }
    };
    void poll();
    return () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [runId]);

  useEffect(() => {
    if (settled) return;
    const id = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [settled]);

  if (contact.kind === "signed-out") {
    return <Terminal title="Your session ended">Live runs are behind the gate. <Link href="/gate">Unlock it again</Link> to keep watching; the run itself carries on.</Terminal>;
  }
  if (contact.kind === "missing") {
    return <Terminal title="No such run">This console has no run with that id. <Link href="/build">Start one from the builder</Link>, or <Link href="/runs">watch a recorded run</Link>.</Terminal>;
  }
  if (view === null) {
    return contact.kind === "lost" ? (
      <Terminal title="Cannot reach the console">The run could not be read. Retrying every 2 s.</Terminal>
    ) : (
      <p className="note" aria-live="polite">Reading the run…</p>
    );
  }
  return <Board view={view} lostForS={contact.kind === "lost" ? Math.round((Date.now() - contact.sinceMs) / 1000) : null} />;
}

function Terminal({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="terminal" role="status">
      <h2>{title}</h2>
      <p>{children}</p>
    </section>
  );
}

function Board({ view, lostForS }: { view: LiveView; lostForS: number | null }) {
  const board = useRef<HTMLDivElement>(null);
  const [geo, setGeo] = useState<Geometry | null>(null);

  const rows: Row[] = useMemo(() => {
    const out: Row[] = view.calls.map((call) => ({ kind: "call", key: call.key, t: call.t, call }));
    for (const d of view.deliveries) out.push({ kind: "delivery", key: d.key, t: d.t, delivery: d });
    for (const p of view.pairs) if (p.arrivedT === null) out.push({ kind: "waiting", key: p.deliveryKey, t: p.callT + 0.001, pair: p });
    return out.sort((a, b) => a.t - b.t);
  }, [view]);

  const measure = useCallback(() => {
    const b = board.current;
    if (b === null) return;
    const narrow = matchMedia("(max-width: 860px)").matches;
    const anchors: Record<string, Anchor> = {};
    const lane = b.querySelector<HTMLElement>("[data-lane]");
    const laneLeft = lane === null ? 0 : lane.offsetLeft + 2;
    const laneRight = lane === null ? 0 : lane.offsetLeft + lane.offsetWidth - 2;
    for (const el of b.querySelectorAll<HTMLElement>("[data-row]")) anchors[el.dataset.row!] = { y: el.offsetTop + 14 };
    const breaks = [...b.querySelectorAll<HTMLElement>("[data-gap]")]
      .filter((g) => Number(g.dataset.gap) >= AXIS_BREAK_S)
      .map((g) => g.offsetTop + g.offsetHeight / 2);
    setGeo({ height: b.offsetHeight, narrow, laneLeft, laneRight, anchors, breaks });
  }, []);

  // Rows arrive while the page is open, so every new row re-measures.
  const rowKeys = rows.map((r) => r.key).join("|");
  useLayoutEffect(() => {
    measure();
    void document.fonts?.ready.then(measure);
    const b = board.current;
    if (b === null || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => measure());
    ro.observe(b);
    for (const el of b.querySelectorAll("[data-row]")) ro.observe(el);
    return () => ro.disconnect();
  }, [measure, rowKeys]);

  let gridRow = 0;
  const items: React.ReactNode[] = [];
  rows.forEach((row, i) => {
    if (i > 0) {
      const gap = row.t - rows[i - 1]!.t;
      items.push(<div key={`g${row.key}`} className="gap" data-gap={gap} style={{ gridRow: ++gridRow, height: gapHeightPx(gap) }} />);
    }
    gridRow += 1;
    if (row.kind === "call") {
      const c = row.call;
      const m = STATUS_MARK[c.status] ?? STATUS_MARK["unknown"]!;
      const ids = Object.entries(c.ids);
      items.push(
        <div key={row.key} data-row={row.key} className="call shown" style={{ gridRow }}>
          <div className="when">+{clock(c.t)} · {utcTime(c.at)} UTC</div>
          <div className="req">{c.step} · {c.kind}</div>
          <div className="what"><Mark kind={m.kind}>{m.word}</Mark></div>
          {c.detail !== "" && <div className="why">{c.detail}</div>}
          {ids.length > 0 && <div className="ids">{ids.map(([k, v]) => `${k} ${v}`).join(" · ")}</div>}
        </div>,
      );
    } else if (row.kind === "delivery") {
      const d = row.delivery;
      items.push(
        <article key={row.key} data-row={row.key} className="delivery shown" style={{ gridRow }}>
          <div className="env-head">
            <span>{d.title}</span>
            <span className="when"><span className="words">seen</span> +{clock(d.t)} · {utcTime(d.at)} UTC</span>
          </div>
          <div className="body">
            <dl>{d.facts.map(([k, v]) => <Fact key={k} k={k} v={v} />)}</dl>
            <div className="proof"><Mark kind="ok">recorded by the store</Mark><span className="cert">its own state endpoint, read every 5 s</span></div>
          </div>
        </article>,
      );
    } else {
      const ended = view.settled;
      items.push(
        <article key={row.key} data-row={row.key} className="delivery waiting shown" style={{ gridRow }}>
          <div className="env-head"><span className="words">{row.pair.what}</span></div>
          <div className="body">
            {ended ? (
              <><Mark kind="stop">not seen</Mark> when the wait ended. Not proof it never arrived.</>
            ) : (
              <><Mark kind="wait">waiting on PayPal</Mark> <span className="mono">{Math.floor(Math.max(0, view.elapsedS - row.pair.callT))} s</span> so far</>
            )}
          </div>
        </article>,
      );
    }
  });

  const links: React.ReactNode[] = [];
  if (geo !== null && rows.length > 0) {
    if (!geo.narrow) {
      links.push(<line key="sl" className="spine" x1={geo.laneLeft} y1={0} x2={geo.laneLeft} y2={geo.height - 4} />);
      links.push(<line key="sr" className="spine" x1={geo.laneRight} y1={0} x2={geo.laneRight} y2={geo.height - 4} />);
      geo.breaks.forEach((y, i) => {
        for (const x of [geo.laneLeft, geo.laneRight]) {
          links.push(<path key={`b${i}${x}`} className="axis-break" d={`M${x - 5} ${y + 1} L${x + 5} ${y - 3} M${x - 5} ${y + 5} L${x + 5} ${y + 1}`} />);
        }
      });
    }
    let lane = 0;
    for (const p of view.pairs) {
      const c = geo.anchors[p.callKey];
      const d = geo.anchors[p.deliveryKey];
      if (c === undefined || d === undefined) continue;
      const arrived = p.arrivedT !== null;
      // Only a connector still being waited on is live; one whose wait ended is not.
      const live = !arrived && !view.settled;
      const cls = arrived ? "link verified" : live ? "link waiting" : "link stopped";
      const label = arrived ? withinLabel(p.arrivedT! - p.callT) : live ? `${Math.floor(Math.max(0, view.elapsedS - p.callT))} s so far` : "not seen";
      const pill = `pill${live ? " live" : ""}`;
      const anchorCls = `anchor ${arrived ? "ok" : live ? "live" : ""}`;
      const w = label.length * 7.2 + 12;
      if (!geo.narrow) {
        const x0 = geo.laneLeft;
        const x1 = geo.laneRight;
        const mx = (x0 + x1) / 2;
        const my = (c.y + d.y) / 2;
        links.push(
          <g key={p.deliveryKey}>
            <path className={cls} d={`M${x0} ${c.y} L${x1} ${d.y}`} />
            <circle className="anchor" cx={x0} cy={c.y} r={4} />
            <circle className={anchorCls} cx={x1} cy={d.y} r={4} />
            <g className={pill}>
              <rect x={mx - w / 2} y={my - 9} width={w} height={18} rx={4} />
              <text x={mx} y={my + 4} textAnchor="middle">{label}</text>
            </g>
          </g>,
        );
      } else {
        const right = 40;
        const x = [33, 20, 7][Math.min(lane++, 2)]!;
        const my = (c.y + d.y) / 2;
        links.push(
          <g key={p.deliveryKey}>
            <path className={cls} d={`M${right} ${c.y} H${x} V${d.y} H${right}`} />
            <circle className="anchor" cx={right} cy={c.y} r={3.5} />
            <circle className={anchorCls} cx={right} cy={d.y} r={3.5} />
            <g className={pill} transform={`rotate(-90 ${x} ${my})`}>
              <rect x={x - w / 2} y={my - 9} width={w} height={18} rx={4} />
              <text x={x} y={my + 4} textAnchor="middle">{label}</text>
            </g>
          </g>,
        );
      }
    }
  }

  const headMark: "ok" | "bug" | "wait" | "stop" =
    view.phase === "complete" ? "ok" : view.phase === "halted" || view.phase === "failed" ? "bug" : view.phase === "abandoned" ? "stop" : "wait";

  return (
    <section className="timeline" aria-labelledby="tl-h">
      <h2 id="tl-h" className="sr">Live run timeline, in time order</h2>
      <div className="live-state" aria-live="polite">
        <p className="headline"><Mark kind={headMark}>{view.headline}</Mark></p>
        {view.detail !== null && <p className="detail">{view.detail}</p>}
        <p className="clock">
          <span className="mono">+{clock(view.elapsedS)}</span> since start
          {view.waitLeftS !== null && <> · <span className="mono">{Math.ceil(view.waitLeftS)} s</span> left in the delivery wait</>}
          {!view.settled && view.lastContactS !== null && <> · last word from the server <span className="mono">{Math.round(view.lastContactS)} s</span> ago</>}
        </p>
        {!view.settled && view.lastContactS !== null && view.lastContactS > 30 && (
          <p className="detail">No word from the server for {Math.round(view.lastContactS)} s. After 90 s the run is marked stopped.</p>
        )}
        {lostForS !== null && <p className="detail">This page lost contact with the console {lostForS} s ago and is retrying. The run carries on without it.</p>}
        {view.storeUnread && <p className="detail">The store&apos;s state endpoint could not be read at least once, so a delivery may show late or not at all.</p>}
      </div>
      {rows.length === 0 ? (
        <p className="note">No step has started yet.</p>
      ) : (
        <>
          <div className="lanes-head" aria-hidden="true">
            <span className="label">REHEARSAL calls PayPal</span>
            <span className="label mid">PayPal took</span>
            <span className="label">The store records it</span>
          </div>
          <div className="board" ref={board}>
            <svg className="links" aria-hidden="true">{links}</svg>
            <div className="lane" data-lane="" aria-hidden="true" style={{ gridRow: `1 / span ${gridRow}` }} />
            {items}
          </div>
        </>
      )}
      <Ledger view={view} />
    </section>
  );
}

function Fact({ k, v }: { k: string; v: string }) {
  return (
    <>
      <dt>{k}</dt>
      <dd>{v}</dd>
    </>
  );
}

/** Every delivery the store recorded since the run started, matched to a call or not. */
function Ledger({ view }: { view: LiveView }) {
  return (
    <section className="ledger" aria-labelledby="ledger-h">
      <h3 id="ledger-h" className="label">Every delivery the store recorded since this run started</h3>
      {view.ledger.length === 0 ? (
        <p className="note">{view.settled ? "None was seen." : "None yet."}</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th scope="col">Event</th><th scope="col">Type</th><th scope="col">Deliveries</th><th scope="col">Store did</th><th scope="col">Cert host</th><th scope="col">First seen</th></tr>
            </thead>
            <tbody>
              {view.ledger.map((l) => (
                <tr key={l.eventId}>
                  <td className="mono">{l.eventId}</td>
                  <td className="mono">{l.eventType ?? "not given"}</td>
                  <td className="mono">{l.deliveries}</td>
                  <td>{[l.fulfilled > 0 ? `fulfilled ${l.fulfilled}` : null, l.duplicatesIgnored > 0 ? `duplicate_ignored ${l.duplicatesIgnored}` : null, l.refused > 0 ? `refused ${l.refused}` : null].filter(Boolean).join(", ") || "recorded"}</td>
                  <td className="mono">{l.certHosts.join(", ") || "none"}</td>
                  <td className="mono">+{clock(l.firstSeenT)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="note">The store&apos;s report says which event each delivery was, but not which call caused it. Only exact matches are joined above: a card order to its capture, a resend to its event&apos;s second delivery.</p>
    </section>
  );
}
