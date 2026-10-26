import type { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { fakePaypal, scenarioWith } from "../../tests/helpers/fakePaypal";
import { createDb } from "../lib/db";
import { type HandlerRegistry, type StepHandler, type StoreSnapshot, defaultHandlers, scenarioDigest } from "../lib/engine";
import { HOSTED_CAPS, STEP_MARGIN_S } from "../lib/hosted";
import { runFinderWorker, runScenarioWorker, timeGuarded } from "../lib/worker";
import { freshDb } from "./pg";
import { TEST_DB_ENV, postgrestOver } from "./postgrest";

/**
 * The worker against the real run SQL (PGlite, through the same HTTP calls it
 * makes to Supabase) and the engine's fake PayPal. Stubbed, and so NOT tested
 * here: PayPal itself (handlers are replaced or fed queued answers), the
 * store (readStore is a function returning snapshots), Vercel's after() and
 * maxDuration, and the clock (a fake one that advances when the code sleeps;
 * the database keeps its own real clock, which is why the reaper cases age
 * rows by hand).
 */

const RUN = "20261025000000-0000aa";
const H = (c: string) => c.repeat(64);
const T0 = Date.parse("2026-10-25T18:00:00Z");

type Harness = Awaited<ReturnType<typeof harness>>;

async function harness(opts: { deadlineS?: number; readStore?: ((since: string) => Promise<StoreSnapshot>) | null; handlers?: Partial<Record<string, StepHandler>> } = {}) {
  const pg = await freshDb();
  const rest = postgrestOver(pg);
  const db = createDb({ url: new URL(TEST_DB_ENV.SUPABASE_URL), key: TEST_DB_ENV.SUPABASE_SERVICE_ROLE_KEY }, { fetchImpl: rest.fetch });
  const started = await pg.query<{ out: string }>(
    `select public.console_start_run('${RUN}', 'scenario', 'recorded', 'plan-x', '${H("a")}', '${H("b")}', '${H("c")}', 20, 5, 5) as out`,
  );
  expect(started.rows[0]!.out).toBe("started");
  let clock = T0;
  const ran: string[] = [];
  const ok: StepHandler = async (ctx) => {
    ran.push(ctx.step.id);
    return { kind: "success", detail: `ran ${ctx.step.id}`, ids: { [`${ctx.step.id}_id`]: `ID-${ctx.step.id}` } };
  };
  const handlers = { ...Object.fromEntries(Object.keys(defaultHandlers).map((k) => [k, ok])), ...(opts.handlers ?? {}) } as unknown as HandlerRegistry;
  const seller = fakePaypal([], "seller");
  const buyer = fakePaypal([], "buyer");
  const logs: string[] = [];
  const deps = {
    db,
    seller: seller.client,
    buyer: buyer.client,
    readStore: opts.readStore === undefined ? null : opts.readStore,
    now: () => new Date(clock),
    sleep: async (ms: number) => {
      clock += ms;
      await new Promise((r) => setTimeout(r, 1));
    },
    log: (l: string) => logs.push(l),
    env: {},
    deadlineMs: T0 + (opts.deadlineS ?? 780) * 1000,
    handlers,
  };
  const events = async () =>
    (await pg.query<{ kind: string; step_id: string | null; data: Record<string, unknown> }>(
      `select kind, step_id, data from public.console_run_events where run_id = '${RUN}' order by seq`,
    )).rows;
  const run = async () =>
    (await pg.query<{ status: string; halt_reason: string | null; state: { steps: Record<string, { status: string; startedAt: string | null; finishedAt: string | null; detail: string }> } }>(
      `select status, halt_reason, state from public.console_runs where id = '${RUN}'`,
    )).rows[0]!;
  return { pg, rest, deps, ran, logs, events, run, sellerCalls: seller.calls, buyerCalls: buyer.calls, advance: (ms: number) => (clock += ms), clockNow: () => clock };
}

const twoStep = () =>
  scenarioWith([
    { id: "o1", kind: "card_order", amount: "40.00" },
    { id: "r1", kind: "refund", from: "o1", mode: "full", needs: ["o1"] },
  ]);

const work = (h: Harness, scenario = twoStep()) => runScenarioWorker({ runId: RUN, scenario, digest: scenarioDigest(scenario) }, h.deps);

const snapshot = (deliveries: Array<Record<string, unknown>>, orders: Array<Record<string, unknown>> = []): StoreSnapshot =>
  ({ orders, deliveries, eventCount: deliveries.length, unverifiedCount: 0 }) as unknown as StoreSnapshot;

describe("runScenarioWorker", () => {
  it("runs every step, saving state and events, waits for deliveries, then finishes complete", async () => {
    let reads = 0;
    const h = await harness({
      readStore: async () => {
        reads += 1;
        return reads < 3
          ? snapshot([])
          : snapshot(
              [{ eventId: "WH-1", eventType: "PAYMENT.CAPTURE.COMPLETED", fulfilled: 1, duplicatesIgnored: 0, other: 0, certHosts: ["api.sandbox.paypal.com"] }],
              [{ captureId: "CAP-1", fulfilmentCount: 1, refundCount: 0, disputeCount: 0, duplicatesIgnored: 0 }],
            );
      },
    });
    await work(h);
    expect(h.ran).toEqual(["o1", "r1"]);
    const run = await h.run();
    expect(run.status).toBe("complete");
    expect(run.state.steps["o1"]!.status).toBe("succeeded");
    const kinds = (await h.events()).map((e) => e.kind);
    expect(kinds[0]).toBe("run_started");
    expect(kinds.filter((k) => k === "step_started")).toHaveLength(2);
    expect(kinds.filter((k) => k === "step_finished")).toHaveLength(2);
    expect(kinds).toContain("delivery");
    expect(kinds.indexOf("deliveries_wait_started")).toBeLessThan(kinds.indexOf("deliveries_wait_ended"));
    expect(kinds.at(-1)).toBe("run_finished");
    const delivery = (await h.events()).find((e) => e.kind === "delivery")!;
    expect(delivery.data).toMatchObject({ event_id: "WH-1", deliveries: 1, fulfilled: 1, cert_hosts: ["api.sandbox.paypal.com"] });
    const order = (await h.events()).find((e) => e.kind === "note" && "order" in e.data)!;
    expect(order.data["order"]).toMatchObject({ capture_id: "CAP-1", fulfilled: 1 });
  });

  // R-044: what the timeline needs to pair exactly, saved through the real SQL.
  it("saves each step's source and finish time, and each delivery's capture ids and receive times", async () => {
    const h = await harness({
      readStore: async () =>
        snapshot([{ eventId: "WH-1", eventType: "PAYMENT.CAPTURE.REFUNDED", fulfilled: 0, duplicatesIgnored: 0, other: 1, captureIds: ["ID-r1"], receivedAt: ["2026-10-25T18:00:03.500Z"] }]),
    });
    await work(h);
    const events = await h.events();
    const finished = Object.fromEntries(events.filter((e) => e.kind === "step_finished").map((e) => [e.step_id, e.data]));
    expect(finished["o1"]).not.toHaveProperty("from");
    expect(finished["r1"]).toMatchObject({ from: "o1", ids: { r1_id: "ID-r1" } });
    for (const d of Object.values(finished)) expect(Date.parse(String((d as Record<string, unknown>)["finished_at"]))).toBeGreaterThanOrEqual(T0);
    const delivery = events.find((e) => e.kind === "delivery")!;
    expect(delivery.data).toMatchObject({ capture_ids: ["ID-r1"], received_at: ["2026-10-25T18:00:03.500Z"] });
  });

  it("emits a delivery again when its count grows, and not when it does not", async () => {
    let reads = 0;
    const d = (n: number) => ({ eventId: "WH-1", eventType: "PAYMENT.CAPTURE.COMPLETED", fulfilled: 1, duplicatesIgnored: n - 1, other: 0 });
    const h = await harness({ readStore: async () => snapshot([d(++reads < 4 ? 1 : 2)]) });
    await work(h);
    const deliveries = (await h.events()).filter((e) => e.kind === "delivery");
    expect(deliveries.map((e) => e.data["deliveries"])).toEqual([1, 2]);
  });

  // PayPal lag: a delivery that arrives after the wait is not invented, and
  // its absence does not fail the run.
  it("ends the wait after 90 s with nothing seen when PayPal is late, and still completes", async () => {
    let h!: Harness;
    h = await harness({
      readStore: async () => (h.clockNow() - T0 > 200_000 ? snapshot([{ eventId: "WH-LATE", fulfilled: 1, duplicatesIgnored: 0, other: 0 }]) : snapshot([])),
    });
    await work(h);
    const ev = await h.events();
    expect(ev.filter((e) => e.kind === "delivery")).toEqual([]);
    expect(ev.find((e) => e.kind === "deliveries_wait_ended")!.data).toEqual({ events_seen: 0 });
    expect((await h.run()).status).toBe("complete");
  });

  it("says once that the store could not be read, and keeps going", async () => {
    const h = await harness({ readStore: async () => { throw new TypeError("fetch failed"); } });
    await work(h);
    const notes = (await h.events()).filter((e) => e.kind === "note" && "store_read_failed" in e.data);
    expect(notes).toHaveLength(1);
    expect((await h.run()).status).toBe("complete");
  });

  it("never reaches PayPal for a step whose started-state could not be saved", async () => {
    let h!: Harness;
    h = await harness({
      handlers: {
        card_order: async (ctx) => {
          h.ran.push(ctx.step.id);
          // The database goes away while the first step is in flight.
          h.rest.down = true;
          return { kind: "success", detail: "ok", ids: {} };
        },
      },
    });
    await work(h);
    expect(h.ran).toEqual(["o1"]);
    h.rest.down = false;
    // No finish could be written; the run is left for the reaper.
    expect((await h.run()).status).toBe("running");
    await h.pg.exec(`update public.console_runs set heartbeat_at = now() - interval '91 seconds'`);
    await h.pg.query("select public.console_reap_runs()");
    expect((await h.run()).status).toBe("abandoned");
  });

  // Verifier finding: with the poller heartbeating beside it, a worker that
  // ignored a refused save kept going. Here only the save is refused; every
  // heartbeat still succeeds, so nothing else can stop the run.
  it("stops at the first refused save, even while its heartbeats still succeed", async () => {
    let h!: Harness;
    let refuse = false;
    h = await harness({
      handlers: {
        card_order: async (ctx) => {
          h.ran.push(ctx.step.id);
          refuse = true;
          return { kind: "success", detail: "ok", ids: {} };
        },
      },
    });
    const real = h.rest.fetch;
    h.deps.db = createDb({ url: new URL(TEST_DB_ENV.SUPABASE_URL), key: TEST_DB_ENV.SUPABASE_SERVICE_ROLE_KEY }, {
      fetchImpl: (async (input: string | URL | Request, init?: RequestInit) =>
        refuse && String(input).endsWith("/rpc/console_save_state") ? Response.json(false) : real(input, init)) as typeof fetch,
    });
    await work(h);
    expect(h.ran).toEqual(["o1"]);
    expect(h.logs.some((l) => /no longer lists it as running/.test(l))).toBe(true);
    expect((await h.events()).map((e) => e.kind)).not.toContain("run_finished");
  });

  it("stops before the next step once the reaper has called the run dead (the fence)", async () => {
    let h!: Harness;
    h = await harness({
      handlers: {
        card_order: async (ctx) => {
          h.ran.push(ctx.step.id);
          await h.pg.exec(`update public.console_runs set heartbeat_at = now() - interval '91 seconds'`);
          await h.pg.query("select public.console_reap_runs()");
          return { kind: "success", detail: "ok", ids: {} };
        },
      },
    });
    await work(h);
    expect(h.ran).toEqual(["o1"]);
    const run = await h.run();
    expect(run.status).toBe("abandoned");
    // The last state the database holds shows o1 started and never finished:
    // the save of its outcome was refused by the fence.
    expect(run.state.steps["o1"]!.startedAt).not.toBeNull();
    expect(run.state.steps["o1"]!.finishedAt).toBeNull();
    const kinds = (await h.events()).map((e) => e.kind);
    expect(kinds).toContain("run_abandoned");
    expect(kinds).not.toContain("run_finished");
  });

  // A server killed mid-step: nothing more is written, the reaper closes the
  // run, and the step it had started is visible as started and unfinished.
  it("leaves a step that was in flight when the server died readable as started, unfinished", async () => {
    let h!: Harness;
    let inFlight!: () => void;
    const reached = new Promise<void>((r) => (inFlight = r));
    h = await harness({
      handlers: {
        card_order: async () => {
          inFlight();
          return new Promise(() => {});
        },
      },
    });
    h.deps.sleep = () => new Promise(() => {});
    void work(h);
    await reached;
    await h.pg.exec(`update public.console_runs set heartbeat_at = now() - interval '91 seconds'`);
    await h.pg.query("select public.console_reap_runs()");
    const run = await h.run();
    expect(run.status).toBe("abandoned");
    expect(run.halt_reason).toMatch(/may have written to PayPal/);
    expect(run.state.steps["o1"]!.startedAt).not.toBeNull();
    expect(run.state.steps["o1"]!.finishedAt).toBeNull();
  });

  it("does not send a step that might outlast this server's time, and says why", async () => {
    // 80 s left: a card order can take 30 s, plus the 60 s margin, so it is not sent.
    const h = await harness({ deadlineS: 80 });
    await work(h);
    expect(h.ran).toEqual([]);
    const run = await h.run();
    expect(run.status).toBe("halted");
    expect(run.state.steps["o1"]!.status).toBe("failed");
    // The poller runs beside the steps and may have slept once already.
    const left = Number(/^not sent: (\d+) s were left/.exec(run.state.steps["o1"]!.detail)?.[1]);
    expect(left).toBeGreaterThan(60);
    expect(left).toBeLessThanOrEqual(80);
  });

  it("fails a dispute with no PayPal call when the hosted bank is empty", async () => {
    const h = await harness({ handlers: { open_dispute: defaultHandlers.open_dispute } });
    await work(h, scenarioWith([{ id: "d1", kind: "open_dispute" }]));
    expect(h.buyerCalls).toEqual([]);
    expect(h.sellerCalls).toEqual([]);
    const run = await h.run();
    expect(run.status).toBe("halted");
    expect(run.state.steps["d1"]!.detail).toBe("the hosted purchase bank has no purchase ready to dispute");
  });

  it("marks the purchase used for this run before the dispute call goes out", async () => {
    let h!: Harness;
    let usedWhenCalled: unknown = null;
    h = await harness({
      handlers: {
        open_dispute: async (ctx) => {
          const claim = await ctx.claimPurchase();
          usedWhenCalled = (await h.pg.query("select status, used_by_run_id from public.console_purchases")).rows[0];
          return claim.ok ? { kind: "failed", detail: `would dispute ${claim.purchase.buyerTransactionId}` } : { kind: "failed", detail: claim.error };
        },
      },
    });
    await h.pg.exec(`insert into public.console_purchases (order_id, capture_id, buyer_transaction_id, amount, currency, created_at)
                     values ('O-1', 'C-1', 'T-1', '25.00', 'USD', now())`);
    await work(h, scenarioWith([{ id: "d1", kind: "open_dispute" }]));
    expect(usedWhenCalled).toEqual({ status: "used", used_by_run_id: RUN });
    expect((await h.run()).state.steps["d1"]!.detail).toBe("would dispute T-1");
  });

  it("starts nothing when the run is no longer queued", async () => {
    const h = await harness();
    await h.pg.exec(`update public.console_runs set created_at = now() - interval '61 seconds'`);
    await h.pg.query("select public.console_reap_runs()");
    await work(h);
    expect(h.ran).toEqual([]);
    expect((await h.run()).status).toBe("abandoned");
  });

  it("records no PayPal body and no secret in any event", async () => {
    const h = await harness({
      handlers: {
        card_order: async () => ({ kind: "failed", detail: `http 422, ${"x".repeat(5000)}`, ids: { order_id: "O".repeat(500) } }),
      },
    });
    await work(h);
    for (const e of await h.events()) {
      expect(JSON.stringify(e.data).length).toBeLessThan(1000);
    }
  });
});

describe("runFinderWorker", () => {
  const overdue = JSON.stringify({
    version: 1,
    name: "Overdue invoice",
    profile: { name: "Test Shop" },
    currency: "USD",
    steps: [
      { id: "invoice", kind: "invoice_create", needs: [], amount: "60.00", dueInDays: -7, itemName: "Wholesale candles" },
      { id: "send", kind: "invoice_send", needs: ["invoice"], from: "invoice" },
    ],
  });

  it("plans the class with one model call, runs it reuse-only, and records the verdict", async () => {
    const calls: string[] = [];
    const h = await harness({
      handlers: {
        invoice_create: async () => ({ kind: "success", detail: "invoice created", ids: { invoice_id: "INV2-E2E" } }),
        invoice_send: async () => ({ kind: "success", detail: "sent; PayPal reads it as OVERDUE", ids: {} }),
      },
      readStore: async () => snapshot([]),
    });
    await runFinderWorker(
      { runId: RUN, classId: "overdue-invoice" },
      {
        ...h.deps,
        generate: async ({ prompt }) => {
          calls.push(prompt);
          return { text: overdue };
        },
        caps: HOSTED_CAPS,
        storeOrigin: "https://rehearsal-store.vercel.app",
      },
    );
    expect(calls).toHaveLength(1);
    const finding = (await h.events()).find((e) => e.kind === "note" && "finding" in e.data)!;
    expect(finding.data["finding"]).toMatchObject({ class_id: "overdue-invoice", verdict: "ok" });
    const kinds = (await h.events()).map((e) => e.kind);
    expect(kinds).not.toContain("deliveries_wait_started");
    expect((await h.run()).status).toBe("complete");
  });

  it("finishes halted with an inconclusive verdict when the model's plan does not fit the template", async () => {
    const h = await harness({ readStore: async () => snapshot([]) });
    await runFinderWorker(
      { runId: RUN, classId: "overdue-invoice" },
      { ...h.deps, generate: async () => ({ text: "not a plan" }), caps: HOSTED_CAPS, storeOrigin: "https://rehearsal-store.vercel.app" },
    );
    expect(h.ran).toEqual([]);
    const finding = (await h.events()).find((e) => e.kind === "note" && "finding" in e.data)!;
    expect((finding.data["finding"] as Record<string, unknown>)["verdict"]).toBe("inconclusive");
    expect((await h.run()).status).toBe("halted");
  });
});

describe("timeGuarded", () => {
  const NOW = Date.parse("2026-10-25T18:00:00Z");
  const sent = async (kind: string, leftS: number) => {
    let called = false;
    const base = { [kind]: async () => ((called = true), { kind: "success", detail: "sent" }) } as unknown as HandlerRegistry;
    const guarded = timeGuarded(base, NOW + leftS * 1000, () => new Date(NOW));
    await guarded[kind as keyof HandlerRegistry](undefined as never);
    return called;
  };

  // Each kind at exactly its worst case plus the 60 s margin, and a millisecond under.
  it.each([
    ["card_order", 30],
    ["refund", 30],
    ["open_dispute", 130],
    ["resend_webhook", 150],
  ])("sends %s with %i s plus the margin left, and not a millisecond less", async (kind, worst) => {
    expect(STEP_MARGIN_S).toBe(60);
    expect(await sent(kind, worst + STEP_MARGIN_S)).toBe(true);
    expect(await sent(kind, worst + STEP_MARGIN_S - 0.001)).toBe(false);
  });

  it("keeps a dispute that a card order would fit in", async () => {
    expect(await sent("card_order", 100)).toBe(true);
    expect(await sent("open_dispute", 100)).toBe(false);
  });
});
