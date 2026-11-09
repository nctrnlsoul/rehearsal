import hostedRun from "../fixtures/hosted-run-20261107230012-f3bb0a.json";
import outOfOrderRun from "../fixtures/hosted-run-20261108005357-c0a4d0.json";
import type { LiveEvent, LiveRead, LiveRunRow } from "./liveView";

/**
 * Hosted live runs, replayed straight from the console database's own rows.
 * Each fixture is its evidence file, byte for byte (tests/hostedReplays.test.ts
 * holds it to that): the run row and every event it wrote, with real ids and
 * real times. Nothing is rebuilt from a summary, so the replay is the exact
 * read a live page polling that run would have seen at each moment.
 */

type Exported = {
  readonly source: string;
  readonly run: Omit<LiveRunRow, "halt_reason" | "heartbeat_at"> & { readonly halt_reason?: string | null; readonly heartbeat_at?: string | null };
  readonly events: readonly LiveEvent[];
};

export type HostedReplay = {
  readonly runId: string;
  readonly title: string;
  readonly summary: string;
  readonly evidence: string;
  readonly record: Exported;
};

export const HOSTED_REPLAYS: readonly HostedReplay[] = [
  {
    runId: "20261107230012-f3bb0a",
    title: "Tiny Bakery, a hosted live run",
    summary: "Two card orders and an invoice, run live from this console on its hosted deployment. Every webhook PayPal sent came back verified.",
    evidence: "evidence/hosted-run-20261107230012-f3bb0a.json",
    // JSON imports infer loose types; the test reads the file itself and checks the shape.
    record: hostedRun as unknown as Exported,
  },
  {
    runId: "20261108005357-c0a4d0",
    title: "Tiny Bakery, webhooks out of order",
    // Checked against the store's recorded receive times: step 2's payment 00:54:17.231, step 1's 00:54:20.008; UNPAID 00:54:25.402, CREATED 00:54:26.851.
    summary: "The Tiny Bakery plan, run live again. PayPal delivered step 2's payment webhook before step 1's, and the invoice's UNPAID event before its CREATED event.",
    evidence: "evidence/hosted-run-20261108005357-c0a4d0.json",
    record: outOfOrderRun as unknown as Exported,
  },
];

export function hostedById(runId: string): HostedReplay | undefined {
  return HOSTED_REPLAYS.find((r) => r.runId === runId);
}

const t0Of = (h: HostedReplay) => Date.parse(h.record.run.started_at ?? h.record.run.created_at);

/** When the replay ends: the run row's own finish time, in seconds from its start. */
export function hostedEndS(h: HostedReplay): number {
  const finished = h.record.run.finished_at;
  const last = Math.max(...h.record.events.map((e) => Date.parse(e.at)));
  return ((finished === null ? last : Date.parse(finished)) - t0Of(h)) / 1000;
}

/**
 * The run as GET /api/runs/[id] would have served it tS seconds in: the
 * events written by then, and the row as it stood. Until the row's finish
 * time it reads as running, with no finish time and no saved state yet (the
 * export holds only the final state). The export carries no heartbeat, so
 * the replay clock stands in for it: the worker beat every few seconds.
 */
export function hostedRead(h: HostedReplay, tS: number): LiveRead {
  const t0 = t0Of(h);
  const end = hostedEndS(h);
  const done = tS >= end;
  const nowMs = t0 + Math.min(tS, end) * 1000;
  const now = new Date(nowMs).toISOString();
  const r = h.record.run;
  return {
    run: {
      id: r.id,
      kind: r.kind,
      plan_source: r.plan_source,
      plan_id: r.plan_id,
      scenario_sha256: r.scenario_sha256,
      status: done ? r.status : "running",
      state: done ? r.state : null,
      halt_reason: done ? (r.halt_reason ?? null) : null,
      created_at: r.created_at,
      started_at: r.started_at,
      heartbeat_at: now,
      finished_at: done ? r.finished_at : null,
    },
    events: h.record.events.filter((e) => Date.parse(e.at) <= nowMs),
    now,
  };
}
