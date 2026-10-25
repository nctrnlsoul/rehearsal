import type { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { freshDb, migrationFiles, sql } from "./pg";

/**
 * The console's migrations (R-040: its own Supabase project), run in order
 * against a real Postgres, then the verify files against the result. Nothing
 * here touches a live project. PGlite runs one query at a time, so these prove
 * the SQL's logic and that each guard is one atomic call; contention between
 * two live sessions rests on Postgres's documented locking, not a measurement.
 */

const H = (c: string) => c.repeat(64);
const one = async <T>(db: PGlite, q: string): Promise<T> => (await db.query<T>(q)).rows[0]!;

const start = (db: PGlite, id: string, opts: { session?: string; ip?: string; limits?: [number, number, number] } = {}) => {
  const [g, s, i] = opts.limits ?? [20, 5, 5];
  return one<{ out: string }>(
    db,
    `select public.console_start_run('${id}', 'scenario', 'recorded', 'plan-x', '${H("a")}',
       '${opts.session ?? H("b")}', '${opts.ip ?? H("c")}', ${g}, ${s}, ${i}) as out`,
  ).then((r) => r.out);
};

const status = (db: PGlite, id: string) =>
  one<{ status: string }>(db, `select status from public.console_runs where id = '${id}'`).then((r) => r.status);

const age = (db: PGlite, id: string, column: string, seconds: number) =>
  db.exec(`update public.console_runs set ${column} = now() - interval '${seconds} seconds' where id = '${id}'`);

describe("migration files", () => {
  it("are the four expected, in order", () => {
    expect(migrationFiles()).toEqual([
      "0001_runs.sql",
      "0002_purchases.sql",
      "0003_plans_counters.sql",
      "0004_start_run.sql",
    ]);
  });

  it("are idempotent: applying all of them twice changes nothing", async () => {
    const db = await freshDb();
    for (const f of migrationFiles()) await db.exec(sql(f));
    expect(await start(db, "20261025000000-000001")).toBe("started");
  });
});

describe("verify files", () => {
  const verifies = ["0001_verify.sql", "0002_verify.sql", "0003_verify.sql", "0004_verify.sql"];
  const tables = ["console_runs", "console_run_events", "console_purchases", "console_plans", "console_counters"];

  it("all pass on the migrated database and leave no row behind", async () => {
    const db = await freshDb();
    for (const v of verifies) {
      const results = await db.exec(sql(v));
      expect(Object.values(results.at(-1)!.rows[0]!)).toEqual(["ok"]);
    }
    for (const t of tables) {
      expect((await db.query(`select * from public.${t}`)).rows).toEqual([]);
    }
  });

  it("fail loudly when RLS is off", async () => {
    const db = await freshDb();
    await db.exec("alter table public.console_run_events disable row level security");
    await expect(db.exec(sql("0001_verify.sql"))).rejects.toThrow(/RLS MISSING on console_run_events/);
  });

  it("fail loudly when a policy exists", async () => {
    const db = await freshDb();
    await db.exec("create policy p on public.console_purchases for select using (true)");
    await expect(db.exec(sql("0002_verify.sql"))).rejects.toThrow(/POLICY PRESENT/);
  });

  it("fail loudly when events stop being append-only", async () => {
    const db = await freshDb();
    await db.exec("grant update on public.console_run_events to service_role");
    await expect(db.exec(sql("0001_verify.sql"))).rejects.toThrow(/append-only/);
  });

  it("fail loudly when anon can call a function", async () => {
    const db = await freshDb();
    await db.exec("grant execute on function public.console_gate_clear(text) to anon");
    await expect(db.exec(sql("0003_verify.sql"))).rejects.toThrow(/only service_role may execute public.console_gate_clear/);
  });

  it("fail loudly when a function runs as its owner", async () => {
    const db = await freshDb();
    await db.exec("alter function public.console_start_run(text, text, text, text, text, text, text, integer, integer, integer) security definer");
    await expect(db.exec(sql("0004_verify.sql"))).rejects.toThrow(/FUNCTION WRONG/);
  });

  it("fail loudly when a migration is missing", async () => {
    const db = await freshDb("0002_purchases.sql");
    await expect(db.exec(sql("0003_verify.sql"))).rejects.toThrow();
    await expect(db.exec(sql("0004_verify.sql"))).rejects.toThrow();
  });
});

describe("table checks", () => {
  it("refuse a run id that is not a run id, and a malformed hash", async () => {
    const db = await freshDb();
    await expect(start(db, "../bank/purchases")).rejects.toThrow(/console_runs_id_shape/);
    // The quota row is written first, so its own key check is the one that refuses.
    await expect(start(db, "20261025000000-000001", { session: "not-a-hash" })).rejects.toThrow(/console_counters_key_shape/);
    await expect(
      db.exec(`insert into public.console_runs (id, kind, plan_source, plan_id, scenario_sha256, session_hash, ip_hash)
               values ('20261025000000-000001', 'scenario', 'recorded', 'p', '${H("a")}', 'not-a-hash', '${H("c")}')`),
    ).rejects.toThrow(/console_runs_session_shape/);
    expect((await db.query("select * from public.console_runs")).rows).toEqual([]);
  });

  it("refuse a second active run even when inserted directly (the index backstop)", async () => {
    const db = await freshDb();
    const ins = (id: string) =>
      db.exec(`insert into public.console_runs (id, kind, plan_source, plan_id, scenario_sha256, session_hash, ip_hash)
               values ('${id}', 'scenario', 'recorded', 'p', '${H("a")}', '${H("b")}', '${H("c")}')`);
    await ins("20261025000000-000001");
    await expect(ins("20261025000000-000002")).rejects.toThrow(/console_runs_one_active/);
  });

  it("refuse an oversized event and an unknown event kind", async () => {
    const db = await freshDb();
    await start(db, "20261025000000-000001");
    await db.query("select public.console_mark_running('20261025000000-000001')");
    const big = JSON.stringify([{ kind: "note", data: { x: "y".repeat(5000) } }]);
    await expect(db.query(`select public.console_add_events('20261025000000-000001', '${big}'::jsonb)`)).rejects.toThrow(/data_size/);
    await expect(
      db.query(`select public.console_add_events('20261025000000-000001', '[{"kind":"payment"}]'::jsonb)`),
    ).rejects.toThrow(/console_run_events_kind/);
  });

  it("refuse a plan description over 2000 characters", async () => {
    const db = await freshDb();
    await expect(
      db.exec(`insert into public.console_plans (session_hash, description, scenario, sha256)
               values ('${H("b")}', '${"x".repeat(2001)}', '{}'::jsonb, '${H("a")}')`),
    ).rejects.toThrow(/description_len/);
  });
});

describe("console_start_run", () => {
  it("starts one run and refuses a second while it is active, spending nothing", async () => {
    const db = await freshDb();
    expect(await start(db, "20261025000000-000001")).toBe("started");
    expect(await start(db, "20261025000000-000002")).toBe("busy");
    expect(await one(db, "select public.console_daily_used('runs_global', 'all') as n")).toEqual({ n: 1 });
  });

  it("names the first full quota and leaves no row: global, then session, then IP", async () => {
    const db = await freshDb();
    expect(await start(db, "20261025000000-000001", { limits: [1, 5, 5] })).toBe("started");
    await db.exec("update public.console_runs set status = 'complete'");
    expect(await start(db, "20261025000000-000002", { limits: [1, 5, 5] })).toBe("runs_global");
    expect(await start(db, "20261025000000-000003", { limits: [20, 1, 5] })).toBe("runs_session");
    // A new session from the same address: the IP backstop refuses it (R-039).
    expect(await start(db, "20261025000000-000004", { session: H("e"), limits: [20, 5, 1] })).toBe("runs_ip");
    // A new session from a new address passes.
    expect(await start(db, "20261025000000-000005", { session: H("e"), ip: H("f"), limits: [20, 5, 1] })).toBe("started");
    const ids = (await db.query<{ id: string }>("select id from public.console_runs order by id")).rows.map((r) => r.id);
    expect(ids).toEqual(["20261025000000-000001", "20261025000000-000005"]);
  });

  it("treats a limit of 0 as full", async () => {
    const db = await freshDb();
    expect(await start(db, "20261025000000-000001", { limits: [0, 5, 5] })).toBe("runs_global");
  });

  it("frees the slot held by a dead run before checking it", async () => {
    const db = await freshDb();
    await start(db, "20261025000000-000001");
    await age(db, "20261025000000-000001", "created_at", 61);
    expect(await start(db, "20261025000000-000002")).toBe("started");
    expect(await status(db, "20261025000000-000001")).toBe("abandoned");
  });
});

describe("the reaper", () => {
  const running = async (db: PGlite, id = "20261025000000-000001") => {
    await start(db, id);
    await db.query(`select public.console_mark_running('${id}')`);
    return id;
  };

  it("leaves a queued run alone for 60 s, then abandons it as never started", async () => {
    const db = await freshDb();
    await start(db, "20261025000000-000001");
    await age(db, "20261025000000-000001", "created_at", 59);
    expect(await one(db, "select public.console_reap_runs() as n")).toEqual({ n: 0 });
    await age(db, "20261025000000-000001", "created_at", 61);
    expect(await one(db, "select public.console_reap_runs() as n")).toEqual({ n: 1 });
    const row = await one<{ halt_reason: string }>(db, "select halt_reason from public.console_runs");
    expect(row.halt_reason).toMatch(/never started; nothing was sent/);
    const ev = await one<{ data: unknown }>(db, "select data from public.console_run_events where kind = 'run_abandoned'");
    expect(ev.data).toEqual({ started: false });
  });

  it("abandons a running run at 90 s without a heartbeat, not at 89", async () => {
    const db = await freshDb();
    const id = await running(db);
    await age(db, id, "heartbeat_at", 89);
    expect(await one(db, "select public.console_reap_runs() as n")).toEqual({ n: 0 });
    await age(db, id, "heartbeat_at", 91);
    expect(await one(db, "select public.console_reap_runs() as n")).toEqual({ n: 1 });
    expect(await status(db, id)).toBe("abandoned");
  });

  it("abandons a run started over 860 s ago even with a fresh heartbeat", async () => {
    const db = await freshDb();
    const id = await running(db);
    await age(db, id, "started_at", 859);
    expect(await one(db, "select public.console_reap_runs() as n")).toEqual({ n: 0 });
    await age(db, id, "started_at", 861);
    expect(await one(db, "select public.console_reap_runs() as n")).toEqual({ n: 1 });
  });

  it("never touches a finished run", async () => {
    const db = await freshDb();
    const id = await running(db);
    await db.query(`select public.console_finish_run('${id}', 'complete', '')`);
    await age(db, id, "heartbeat_at", 10_000);
    await age(db, id, "started_at", 10_000);
    expect(await one(db, "select public.console_reap_runs() as n")).toEqual({ n: 0 });
    expect(await status(db, id)).toBe("complete");
  });
});

describe("the fence", () => {
  it("lets a running run write, and refuses every write once it is abandoned", async () => {
    const db = await freshDb();
    await start(db, "20261025000000-000001");
    const id = "20261025000000-000001";
    expect(await one(db, `select public.console_mark_running('${id}') as ok`)).toEqual({ ok: true });
    expect(await one(db, `select public.console_save_state('${id}', '{"v":1}'::jsonb, '[{"kind":"step_started","step_id":"a"}]'::jsonb) as ok`)).toEqual({ ok: true });
    await age(db, id, "heartbeat_at", 91);
    await db.query("select public.console_reap_runs()");
    for (const q of [
      `select public.console_save_state('${id}', '{"v":2}'::jsonb, '[]'::jsonb) as ok`,
      `select public.console_heartbeat('${id}') as ok`,
      `select public.console_add_events('${id}', '[{"kind":"note"}]'::jsonb) as ok`,
      `select public.console_finish_run('${id}', 'complete', '') as ok`,
      `select public.console_mark_running('${id}') as ok`,
    ]) {
      expect(await one(db, q)).toEqual({ ok: false });
    }
    const state = await one<{ state: unknown }>(db, `select state from public.console_runs where id = '${id}'`);
    expect(state.state).toEqual({ v: 1 });
  });

  it("writes state and its events together", async () => {
    const db = await freshDb();
    const id = "20261025000000-000001";
    await start(db, id);
    await db.query(`select public.console_mark_running('${id}')`);
    await db.query(
      `select public.console_save_state('${id}', '{"v":1}'::jsonb,
         '[{"kind":"step_started","step_id":"a"},{"kind":"step_finished","step_id":"a","data":{"status":"succeeded"}}]'::jsonb)`,
    );
    const ev = await db.query<{ kind: string; step_id: string | null }>(
      `select kind, step_id from public.console_run_events where run_id = '${id}' order by seq`,
    );
    expect(ev.rows).toEqual([
      { kind: "run_started", step_id: null },
      { kind: "step_started", step_id: "a" },
      { kind: "step_finished", step_id: "a" },
    ]);
  });

  it("refuses a finish status the worker does not set", async () => {
    const db = await freshDb();
    await start(db, "20261025000000-000001");
    await expect(db.query("select public.console_finish_run('20261025000000-000001', 'abandoned', '')")).rejects.toThrow(/does not set/);
  });
});

describe("console_claim_purchase", () => {
  const bank = async (db: PGlite) => {
    await db.exec(`insert into public.console_purchases (order_id, capture_id, buyer_transaction_id, amount, currency, created_at) values
      ('O-NEW', 'C-2', 'T-2', '25.00', 'USD', now()),
      ('O-OLD', 'C-1', 'T-1', '25.00', 'USD', now() - interval '1 day')`);
  };

  it("draws the oldest first, never the same one twice, and nothing when empty", async () => {
    const db = await freshDb();
    await bank(db);
    const id = "20261025000000-000001";
    await start(db, id);
    await db.query(`select public.console_mark_running('${id}')`);
    const draw = () => db.query<{ order_id: string }>(`select order_id from public.console_claim_purchase('${id}')`).then((r) => r.rows);
    expect(await draw()).toEqual([{ order_id: "O-OLD" }]);
    expect(await draw()).toEqual([{ order_id: "O-NEW" }]);
    expect(await draw()).toEqual([]);
    expect(await one(db, "select available, used from public.console_bank_counts()")).toEqual({ available: 0, used: 2 });
  });

  it("draws nothing for a run that is not running", async () => {
    const db = await freshDb();
    await bank(db);
    await start(db, "20261025000000-000001");
    expect((await db.query("select * from public.console_claim_purchase('20261025000000-000001')")).rows).toEqual([]);
    expect(await one(db, "select available, used from public.console_bank_counts()")).toEqual({ available: 2, used: 0 });
  });

  it("refuses a used purchase with no run recorded against it", async () => {
    const db = await freshDb();
    await bank(db);
    await expect(db.exec("update public.console_purchases set status = 'used'")).rejects.toThrow(/used_has_run/);
  });
});

describe("daily quotas", () => {
  it("are all or nothing across scopes, and refuse at limit + 1", async () => {
    const db = await freshDb();
    const take = (lims: [number, number]) =>
      one<{ out: string | null }>(
        db,
        `select public.console_take_daily(array['model_global','model_session'], array['all','${H("b")}'], array[${lims[0]}, ${lims[1]}]) as out`,
      ).then((r) => r.out);
    for (let i = 0; i < 8; i += 1) expect(await take([30, 8])).toBeNull();
    expect(await take([30, 8])).toBe("model_session");
    expect(await one(db, "select public.console_daily_used('model_global', 'all') as n")).toEqual({ n: 8 });
  });

  it("start counting again on a new UTC day", async () => {
    const db = await freshDb();
    const take = () => one<{ out: string | null }>(db, `select public.console_take_daily(array['model_global'], array['all'], array[1]) as out`).then((r) => r.out);
    expect(await take()).toBeNull();
    expect(await take()).toBe("model_global");
    await db.exec("update public.console_counters set window_start = window_start - interval '1 day'");
    expect(await take()).toBeNull();
  });

  it("refuse a scope that is not daily, and arrays of different lengths", async () => {
    const db = await freshDb();
    await expect(db.query("select public.console_take_daily(array['gate_ip'], array['all'], array[5])")).rejects.toThrow(/not daily/);
    await expect(db.query("select public.console_take_daily(array['model_global'], array['all','all'], array[5])")).rejects.toThrow(/one length/);
  });
});

describe("the gate counters (same rules as the old AttemptLimiter, slot taken first)", () => {
  const take = (db: PGlite, key: string, perIp = 5) =>
    one<{ allowed: boolean; ip_left: number; retry_after_s: number }>(db, `select * from public.console_gate_take('${key}', ${perIp}, 3600)`);
  const fail = (db: PGlite, global = 50) =>
    one<{ hit: boolean }>(db, `select public.console_gate_fail(${global}, 3600) as hit`).then((r) => r.hit);

  it("allows 5 tries per address, then refuses for the rest of the hour without counting more", async () => {
    const db = await freshDb();
    for (let i = 1; i <= 5; i += 1) expect(await take(db, H("1"))).toEqual({ allowed: true, ip_left: 5 - i, retry_after_s: 0 });
    const locked = await take(db, H("1"));
    expect(locked.allowed).toBe(false);
    expect(locked.retry_after_s).toBeGreaterThan(3500);
    expect(locked.retry_after_s).toBeLessThanOrEqual(3600);
    const row = await one<{ count: number }>(db, "select count from public.console_counters where scope = 'gate_ip'");
    expect(row.count).toBe(5);
    // Another address is untouched.
    expect(await take(db, H("2"))).toMatchObject({ allowed: true, ip_left: 4 });
  });

  it("starts a fresh window once the hour since the first try has passed", async () => {
    const db = await freshDb();
    for (let i = 0; i < 5; i += 1) await take(db, H("1"));
    await db.exec(`update public.console_counters set window_start = now() - interval '3600 seconds' where scope = 'gate_ip'`);
    expect(await take(db, H("1"))).toMatchObject({ allowed: true, ip_left: 4 });
  });

  it("reports the global ceiling exactly once and refuses no one for it (R-036)", async () => {
    const db = await freshDb();
    const hits: boolean[] = [];
    for (let i = 0; i < 4; i += 1) hits.push(await fail(db, 3));
    expect(hits).toEqual([false, false, true, false]);
    expect(await take(db, H("9"))).toMatchObject({ allowed: true, ip_left: 4 });
  });

  it("clears an address on success without lowering the global count", async () => {
    const db = await freshDb();
    for (let i = 0; i < 3; i += 1) {
      await take(db, H("1"));
      await fail(db);
    }
    await db.query(`select public.console_gate_clear('${H("1")}')`);
    expect(await take(db, H("1"))).toMatchObject({ allowed: true, ip_left: 4 });
    const g = await one<{ count: number }>(db, "select count from public.console_counters where scope = 'gate_global'");
    expect(g.count).toBe(3);
  });

  it("after a clear, the next try starts its own window", async () => {
    const db = await freshDb();
    await take(db, H("1"));
    await db.exec(`update public.console_counters set window_start = now() - interval '3000 seconds' where scope = 'gate_ip'`);
    await db.query(`select public.console_gate_clear('${H("1")}')`);
    for (let i = 0; i < 5; i += 1) await take(db, H("1"));
    const locked = await take(db, H("1"));
    expect(locked.allowed).toBe(false);
    // A window kept from before the clear would end in about 600 s.
    expect(locked.retry_after_s).toBeGreaterThan(3500);
  });

  it("treats a per-address limit under 1 as locked", async () => {
    const db = await freshDb();
    expect(await take(db, H("1"), 0)).toMatchObject({ allowed: false });
  });

  it("stores no raw address: a key must be a 64-hex hash", async () => {
    const db = await freshDb();
    await expect(take(db, "203.0.113.7")).rejects.toThrow(/console_counters_key_shape/);
  });
});

describe("reads", () => {
  it("console_read_run reaps first, returns events after the cursor, and never the hashes", async () => {
    const db = await freshDb();
    const id = "20261025000000-000001";
    await start(db, id);
    await db.query(`select public.console_mark_running('${id}')`);
    await db.query(`select public.console_add_events('${id}', '[{"kind":"note"},{"kind":"note"}]'::jsonb)`);
    const all = await one<{ v: { run: Record<string, unknown>; events: Array<{ seq: number }>; now: string } }>(
      db, `select public.console_read_run('${id}', 0, 200) as v`);
    expect(all.v.run["status"]).toBe("running");
    expect(all.v.run).not.toHaveProperty("session_hash");
    expect(all.v.run).not.toHaveProperty("ip_hash");
    expect(all.v.events).toHaveLength(3);
    const after = await one<{ v: { events: unknown[] } }>(
      db, `select public.console_read_run('${id}', ${all.v.events[1]!.seq}, 200) as v`);
    expect(after.v.events).toHaveLength(1);
    await age(db, id, "heartbeat_at", 91);
    const dead = await one<{ v: { run: { status: string } } }>(db, `select public.console_read_run('${id}', 0, 200) as v`);
    expect(dead.v.run.status).toBe("abandoned");
    expect(await one(db, "select public.console_read_run('20261025000000-999999', 0, 200) as v")).toEqual({ v: null });
  });

  it("console_read_run caps a page at 200 events", async () => {
    const db = await freshDb();
    const id = "20261025000000-000001";
    await start(db, id);
    await db.query(`select public.console_mark_running('${id}')`);
    const batch = JSON.stringify(Array.from({ length: 250 }, () => ({ kind: "note" })));
    await db.query(`select public.console_add_events('${id}', '${batch}'::jsonb)`);
    const page = await one<{ n: number }>(db, `select jsonb_array_length(public.console_read_run('${id}', 0, 100000) -> 'events') as n`);
    expect(page.n).toBe(200);
  });

  it("console_active_run names the run holding the slot, and nothing once it is done", async () => {
    const db = await freshDb();
    expect(await one(db, "select public.console_active_run() as id")).toEqual({ id: null });
    await start(db, "20261025000000-000001");
    expect(await one(db, "select public.console_active_run() as id")).toEqual({ id: "20261025000000-000001" });
    await db.exec("update public.console_runs set status = 'complete'");
    expect(await one(db, "select public.console_active_run() as id")).toEqual({ id: null });
  });

  it("a saved plan reads back exactly, without its session hash", async () => {
    const db = await freshDb();
    const saved = await one<{ id: string }>(
      db, `select public.console_save_plan('${H("b")}', 'a candle shop', '{"name":"x","steps":[]}'::jsonb, '${H("a")}') as id`);
    const got = await one<{ v: Record<string, unknown> }>(db, `select public.console_get_plan('${saved.id}') as v`);
    expect(got.v).toMatchObject({ id: saved.id, description: "a candle shop", scenario: { name: "x", steps: [] }, sha256: H("a") });
    expect(got.v).not.toHaveProperty("session_hash");
    expect(await one(db, "select public.console_get_plan('00000000-0000-0000-0000-000000000000') as v")).toEqual({ v: null });
  });
});
