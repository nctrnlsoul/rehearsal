"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { type LiveEvent, type LiveRead, type LiveRunRow, mergeEvents } from "../lib/liveView";
import { runStory } from "../lib/runStory";
import { RunView } from "./RunView";

/**
 * A live run, read from this console's own API every 2 s and drawn by the
 * same RunView a replay uses. The story is re-derived once a second between
 * polls so a waiting step's "so far" counts on the server's clock.
 */

const POLL_MS = 2000;

type Contact = { kind: "ok" } | { kind: "signed-out" } | { kind: "missing" } | { kind: "lost"; sinceMs: number };

/** names: the recorded plans and finder classes by id; a plan written by the model is "Your plan". */
export function LiveRun({ runId, names }: { runId: string; names: Readonly<Record<string, string>> }) {
  const [run, setRun] = useState<LiveRunRow | null>(null);
  const [events, setEvents] = useState<LiveEvent[]>([]);
  // The database's clock minus ours, so "so far" counts on the server's time.
  const [offsetMs, setOffsetMs] = useState(0);
  const [contact, setContact] = useState<Contact>({ kind: "ok" });
  const [tick, setTick] = useState(0);
  const lastSeq = useRef(0);

  const story = useMemo(() => {
    if (run === null) return null;
    const read: LiveRead = { run, events, now: new Date(Date.now() + offsetMs).toISOString() };
    return runStory(read);
    // tick is listed so the counters re-derive once a second.
  }, [run, events, offsetMs, tick]);

  const settled = story?.settled ?? false;

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
    return <Terminal title="No such run">This console has no run with that id. <Link href="/live">Start one</Link>, or <Link href="/runs">watch a recorded run</Link>.</Terminal>;
  }
  if (story === null) {
    return contact.kind === "lost" ? (
      <Terminal title="Cannot reach the console">The run could not be read. Retrying every 2 s.</Terminal>
    ) : (
      <section className="hero"><div className="wrap"><p className="lead" aria-live="polite">Reading the run…</p></div></section>
    );
  }
  const lostForS = contact.kind === "lost" ? Math.round((Date.now() - contact.sinceMs) / 1000) : null;
  const name = names[run!.plan_id] ?? (run!.kind === "finder" ? "Finder run" : "Your plan");
  return (
    <>
      {lostForS !== null && (
        <div className="wrap"><p className="note" role="status">This page lost contact with the console {lostForS} s ago and is retrying. The run carries on without it.</p></div>
      )}
      <RunView story={story} name={name} runId={runId} mode="live" />
    </>
  );
}

function Terminal({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="wrap">
      <section className="card terminal" role="status">
        <h2>{title}</h2>
        <p>{children}</p>
      </section>
    </div>
  );
}
