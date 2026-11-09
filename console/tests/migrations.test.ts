import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { SUPABASE_ROLES, freshDb, migrationFiles, sql } from "./pg";

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

// Ages a row and reaps in ONE transaction, so both read the same now() and a
// boundary is tested exactly: a row aged 60 s is 60 s old to the reaper, not
// 60 s plus however long the next query took to arrive.
const ageThenReap = async (db: PGlite, id: string, column: string, seconds: number) => {
  const out = await db.exec(
    `begin;
     update public.console_runs set ${column} = now() - interval '${seconds} seconds' where id = '${id}';
     select public.console_reap_runs() as n;
     commit;`,
  );
  return (out.find((r) => r.fields.some((f) => f.name === "n"))!.rows[0] as { n: number }).n;
};

describe("migration files", () => {
  it("are the four expected, in order", () => {
    expect(migrationFiles()).toEqual([
      "0001_runs.sql",
      "0002_purchases.sql",
      "0003_plans_counters.sql",
      "0004_start_run.sql",
      "0005_lock_rls_auto_enable.sql",
    ]);
  });

  // R-047: applied live on 2026-10-26 as console_0005_lock_rls_auto_enable. The
  // statements were read back from that project's supabase_migrations history
  // (version 20261026004948) on 2026-11-08; the committed file must say the same.
  it("0005 carries the live migration's statements, word for word", () => {
    const statements = sql("0005_lock_rls_auto_enable.sql")
      .split(/\r?\n/)
      .filter((l) => l.trim() !== "" && !l.startsWith("--"))
      .join("\n");
    expect(statements).toBe("revoke execute on function public.rls_auto_enable() from public, anon, authenticated;\nnotify pgrst, 'reload schema';");
  });

  it("0005 leaves no API role, and not public, able to execute rls_auto_enable()", async () => {
    const before = new PGlite();
    await before.exec(SUPABASE_ROLES);
    const can = async (db: PGlite, role: string) =>
      (await db.query<{ ok: boolean }>(`select has_function_privilege('${role}', 'public.rls_auto_enable()', 'execute') as ok`)).rows[0]!.ok;
    // What Supabase hands the migration: both API roles can call it.
    expect(await can(before, "anon")).toBe(true);
    expect(await can(before, "authenticated")).toBe(true);
    await before.close();
    const db = await freshDb();
    expect(await can(db, "anon")).toBe(false);
    expect(await can(db, "authenticated")).toBe(false);
    const acl = (await db.query<{ acl: string }>(`select coalesce(proacl::text, '') as acl from pg_proc where proname = 'rls_auto_enable'`)).rows[0]!.acl;
    // No "=X/" entry: PUBLIC holds no execute grant.
    expect(acl).not.toMatch(/(^|[{,])=X/);
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
    await db.exec("grant execute on function public.console_gate_fail(integer, integer) to anon");
    await expect(db.exec(sql("0003_verify.sql"))).rejects.toThrow(/only service_role may execute public.console_gate_fail/);
  });

  it("fail loudly when the service role can truncate, reference or trigger", async () => {
    for (const [grant, file] of [
      ["truncate on public.console_counters", "0003_verify.sql"],
      ["references on public.console_runs", "0001_verify.sql"],
      ["trigger on public.console_purchases", "0002_verify.sql"],
    ] as const) {
      const db = await freshDb();
      await db.exec(`grant ${grant} to service_role`);
      await expect(db.exec(sql(file)), grant).rejects.toThrow(/GRANT WRONG/);
      await expect(db.exec(sql("0004_verify.sql")), grant).rejects.toThrow(/GRANT WRONG/);
    }
  });

  // The sweep in 0004_verify finds objects by name, so one no list mentions is still checked.
  it("the last verify file catches a console table, sequence or function no list names", async () => {
    const open = [
      ["create table public.console_extra (id int primary key)", /RLS MISSING on console_extra/],
      ["create sequence public.console_extra_seq", /sequence console_extra_seq is usable/],
      [
        "create function public.console_extra() returns int language sql security invoker set search_path = '' as 'select 1'",
        /only service_role may execute console_extra\(\)/,
      ],
      [
        "create function public.console_extra() returns int language sql security definer set search_path = '' as 'select 1'",
        /FUNCTION WRONG: console_extra\(\)/,
      ],
      ["grant select on public.console_runs to public", /PUBLIC holds a privilege on console_runs/],
      // Second verifier, D1 to D5: each passed every verify file before.
      ["grant select (id, status) on public.console_runs to anon", /console_runs has column-level grants/],
      ["grant update (kind) on public.console_run_events to service_role", /console_run_events has column-level grants/],
      ["grant maintain on public.console_counters to anon", /console_counters grants something beyond service_role/],
      ["create table public.console_extra_p (id int) partition by range (id)", /RLS MISSING on console_extra_p/],
      ["create view public.console_peek as select id, session_hash from public.console_runs", /console_peek is a view/],
    ] as const;
    for (const [ddl, error] of open) {
      const db = await freshDb();
      await db.exec(ddl);
      await expect(db.exec(sql("0004_verify.sql")), ddl).rejects.toThrow(error);
    }
  });

  it("fail loudly when a function runs as its owner", async () => {
    const db = await freshDb();
    await db.exec("alter function public.console_start_run(text, text, text, text, text, text, text, integer, integer, integer, integer[]) security definer");
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
    expect(await ageThenReap(db, "20261025000000-000001", "created_at", 60)).toBe(0);
    expect(await ageThenReap(db, "20261025000000-000001", "created_at", 60.5)).toBe(1);
    const row = await one<{ halt_reason: string }>(db, "select halt_reason from public.console_runs");
    expect(row.halt_reason).toMatch(/never started; nothing was sent/);
    const ev = await one<{ data: unknown }>(db, "select data from public.console_run_events where kind = 'run_abandoned'");
    expect(ev.data).toEqual({ started: false });
  });

  it("abandons a running run just past 90 s without a heartbeat, not at 90", async () => {
    const db = await freshDb();
    const id = await running(db);
    expect(await ageThenReap(db, id, "heartbeat_at", 90)).toBe(0);
    expect(await ageThenReap(db, id, "heartbeat_at", 90.5)).toBe(1);
    expect(await status(db, id)).toBe("abandoned");
  });

  it("abandons a run started just past 860 s ago even with a fresh heartbeat, not at 860", async () => {
    const db = await freshDb();
    const id = await running(db);
    expect(await ageThenReap(db, id, "started_at", 860)).toBe(0);
    expect(await ageThenReap(db, id, "started_at", 860.5)).toBe(1);
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

  // Verifier finding: the fence used to hold only after something polled. A
  // server silent for 300 s could still save state and draw a purchase. One
  // fresh database per write, so each write's own reap is what refuses it
  // (the second verifier found that one shared database let the first write
  // reap the run for all the others).
  const ID = "20261025000000-000001";
  const writes: Array<[string, string]> = [
    ["save_state", `select public.console_save_state('${ID}', '{"v":2}'::jsonb, '[]'::jsonb) as ok`],
    ["heartbeat", `select public.console_heartbeat('${ID}') as ok`],
    ["add_events", `select public.console_add_events('${ID}', '[{"kind":"note"}]'::jsonb) as ok`],
    ["finish_run", `select public.console_finish_run('${ID}', 'complete', '') as ok`],
    ["claim_purchase", `select (select count(*) from public.console_claim_purchase('${ID}')) = 1 as ok`],
  ];
  const deadRun = async (column: string, seconds: number) => {
    const db = await freshDb();
    await start(db, ID);
    await db.query(`select public.console_mark_running('${ID}')`);
    await db.exec(`insert into public.console_purchases (order_id, capture_id, buyer_transaction_id, amount, currency, created_at)
                   values ('O-1', 'C-1', 'T-1', '25.00', 'USD', now())`);
    await age(db, ID, column, seconds);
    return db;
  };
  it.each(writes)("refuses a dead run's own %s even when nobody has polled", async (_name, q) => {
    for (const [column, seconds] of [["heartbeat_at", 300], ["started_at", 900]] as const) {
      const db = await deadRun(column, seconds);
      expect(await one(db, q), column).toEqual({ ok: false });
      expect(await status(db, ID)).toBe("abandoned");
      expect(await one(db, "select available from public.console_bank_counts()")).toEqual({ available: 1 });
    }
  });

  it("a claim heartbeats the run, so a reap right after it does not call the run dead", async () => {
    const db = await freshDb();
    const id = "20261025000000-000001";
    await start(db, id);
    await db.query(`select public.console_mark_running('${id}')`);
    await db.exec(`insert into public.console_purchases (order_id, capture_id, buyer_transaction_id, amount, currency, created_at)
                   values ('O-1', 'C-1', 'T-1', '25.00', 'USD', now())`);
    await age(db, id, "heartbeat_at", 80);
    expect((await db.query(`select order_id from public.console_claim_purchase('${id}')`)).rows).toEqual([{ order_id: "O-1" }]);
    const hb = await one<{ s: number }>(db, `select extract(epoch from now() - heartbeat_at) as s from public.console_runs where id = '${id}'`);
    expect(Number(hb.s)).toBeLessThan(5);
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

describe("the gate counters (slot taken first, a right passcode gives back only its own)", () => {
  const take = (db: PGlite, key: string, perIp = 5) =>
    one<{ allowed: boolean; ip_left: number; retry_after_s: number; since: unknown }>(db, `select * from public.console_gate_take('${key}', ${perIp}, 3600)`);
  const fail = (db: PGlite, global = 50) =>
    one<{ hit: boolean }>(db, `select public.console_gate_fail(${global}, 3600) as hit`).then((r) => r.hit);

  it("allows 5 tries per address, then refuses for the rest of the hour without counting more", async () => {
    const db = await freshDb();
    for (let i = 1; i <= 5; i += 1) expect(await take(db, H("1"))).toMatchObject({ allowed: true, ip_left: 5 - i, retry_after_s: 0 });
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

  it("gives back exactly one slot on a release, never more, and never below zero", async () => {
    const db = await freshDb();
    let since: unknown = null;
    for (let i = 0; i < 5; i += 1) since = (await take(db, H("1"))).since;
    await db.query(`select public.console_gate_release('${H("1")}', $1)`, [since]);
    expect(await take(db, H("1"))).toMatchObject({ allowed: true, ip_left: 0 });
    expect(await take(db, H("1"))).toMatchObject({ allowed: false });
    const s2 = (await take(db, H("2"))).since;
    for (let i = 0; i < 3; i += 1) await db.query(`select public.console_gate_release('${H("2")}', $1)`, [s2]);
    const c = await one<{ count: number }>(db, `select count from public.console_counters where key = '${H("2")}'`);
    expect(c.count).toBe(0);
  });

  // Second verifier, D6: the hour ended while a judge's passcode was being
  // hashed, a guesser's try opened a new window, and the judge's release then
  // took that new window's count to zero: 6 tries against a limit of 5.
  it("gives nothing back when the window the slot was taken in has already ended", async () => {
    const db = await freshDb();
    for (let i = 0; i < 4; i += 1) await take(db, H("1"));
    const judge = await take(db, H("1"));
    await db.exec(`update public.console_counters set window_start = window_start - interval '3600 seconds' where scope = 'gate_ip'`);
    expect(await take(db, H("1"))).toMatchObject({ allowed: true, ip_left: 4 });
    await db.query(`select public.console_gate_release('${H("1")}', $1)`, [judge.since]);
    for (let i = 0; i < 4; i += 1) expect(await take(db, H("1"))).toMatchObject({ allowed: true });
    expect(await take(db, H("1"))).toMatchObject({ allowed: false });
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

describe("console_start_run for a finder", () => {
  const finder = (db: PGlite, id: string, model: string | null, limits: [number, number, number] = [20, 5, 5]) =>
    one<{ out: string }>(
      db,
      `select public.console_start_run('${id}', 'finder', 'finder', 'duplicate-webhook', null, '${H("b")}', '${H("c")}',
         ${limits[0]}, ${limits[1]}, ${limits[2]}, ${model === null ? "null" : `array[${model}]`}) as out`,
    ).then((r) => r.out);

  it("takes a run and a model call together", async () => {
    const db = await freshDb();
    expect(await finder(db, "20261025000000-000001", "30, 8, 8")).toBe("started");
    expect(await one(db, "select public.console_daily_used('runs_global', 'all') as n")).toEqual({ n: 1 });
    expect(await one(db, "select public.console_daily_used('model_global', 'all') as n")).toEqual({ n: 1 });
  });

  it("spends neither when the model quota is full", async () => {
    const db = await freshDb();
    expect(await finder(db, "20261025000000-000001", "30, 0, 8")).toBe("model_session");
    expect(await one(db, "select public.console_daily_used('runs_global', 'all') as n")).toEqual({ n: 0 });
    expect((await db.query("select * from public.console_runs")).rows).toEqual([]);
  });

  it("refuses a finder without model limits, and a scenario run with them", async () => {
    const db = await freshDb();
    await expect(finder(db, "20261025000000-000001", null)).rejects.toThrow(/finder run takes model limits/);
    await expect(
      db.query(`select public.console_start_run('20261025000000-000002', 'scenario', 'recorded', 'p', '${H("a")}', '${H("b")}', '${H("c")}', 20, 5, 5, array[30, 8, 8])`),
    ).rejects.toThrow(/finder run takes model limits/);
  });
});

describe("console_cancel_start", () => {
  it("closes a queued run as never started and gives its quotas back", async () => {
    const db = await freshDb();
    expect(await start(db, "20261025000000-000001")).toBe("started");
    expect(await one(db, "select public.console_cancel_start('20261025000000-000001') as ok")).toEqual({ ok: true });
    expect(await status(db, "20261025000000-000001")).toBe("abandoned");
    for (const [scope, key] of [["runs_global", "all"], ["runs_session", H("b")], ["runs_ip", H("c")]]) {
      expect(await one(db, `select public.console_daily_used('${scope}', '${key}') as n`), scope).toEqual({ n: 0 });
    }
    // The slot is free at once, not after the reaper's 60 s.
    expect(await start(db, "20261025000000-000002")).toBe("started");
  });

  it("gives a finder's model call back too", async () => {
    const db = await freshDb();
    await db.query(`select public.console_start_run('20261025000000-000001', 'finder', 'finder', 'duplicate-webhook', null,
                      '${H("b")}', '${H("c")}', 20, 5, 5, array[30, 8, 8])`);
    await db.query("select public.console_cancel_start('20261025000000-000001')");
    expect(await one(db, `select public.console_daily_used('model_session', '${H("b")}') as n`)).toEqual({ n: 0 });
    expect(await one(db, "select public.console_daily_used('model_global', 'all') as n")).toEqual({ n: 0 });
  });

  it("refuses a run a worker has already marked running, and keeps its quota spent", async () => {
    const db = await freshDb();
    await start(db, "20261025000000-000001");
    await db.query("select public.console_mark_running('20261025000000-000001')");
    expect(await one(db, "select public.console_cancel_start('20261025000000-000001') as ok")).toEqual({ ok: false });
    expect(await status(db, "20261025000000-000001")).toBe("running");
    expect(await one(db, "select public.console_daily_used('runs_global', 'all') as n")).toEqual({ n: 1 });
  });

  it("never touches another day's count", async () => {
    const db = await freshDb();
    await start(db, "20261025000000-000001");
    await db.exec("update public.console_counters set window_start = window_start - interval '1 day'");
    await db.query("select public.console_cancel_start('20261025000000-000001')");
    const counts = (await db.query<{ count: number }>("select count from public.console_counters")).rows.map((r) => r.count);
    expect(counts).toEqual([1, 1, 1]);
  });
});

describe("as service_role, the role the console's key acts as", () => {
  const as = (db: PGlite, role: string, q: string) =>
    db.transaction(async (tx) => {
      await tx.exec(`set local role ${role}`);
      return tx.query(q);
    });

  it("can do everything the console does, through the functions", async () => {
    const db = await freshDb();
    const r = await as(
      db,
      "service_role",
      `select public.console_start_run('20261025000000-000001', 'scenario', 'recorded', 'p', '${H("a")}', '${H("b")}', '${H("c")}', 20, 5, 5) as out`,
    );
    expect(r.rows).toEqual([{ out: "started" }]);
    expect((await as(db, "service_role", "select public.console_mark_running('20261025000000-000001') as ok")).rows).toEqual([{ ok: true }]);
    expect((await as(db, "service_role", `select public.console_add_events('20261025000000-000001', '[{"kind":"note"}]'::jsonb) as ok`)).rows).toEqual([
      { ok: true },
    ]);
  });

  // Verifier finding: under Supabase's default privileges the service role kept
  // DELETE, TRUNCATE and UPDATE on the event log, because nothing revoked them.
  it("cannot delete or truncate anything, or rewrite an event or a plan, under Supabase's default grants", async () => {
    const db = await freshDb();
    await start(db, "20261025000000-000001");
    for (const q of [
      "delete from public.console_runs",
      "delete from public.console_run_events",
      "truncate public.console_counters",
      "update public.console_run_events set kind = 'note'",
      "update public.console_plans set description = 'x'",
      "delete from public.console_purchases",
    ]) {
      await expect(as(db, "service_role", q), q).rejects.toThrow(/permission denied/);
    }
  });

  it("anon and authenticated can read nothing and call nothing", async () => {
    const db = await freshDb();
    for (const role of ["anon", "authenticated"]) {
      for (const q of ["select * from public.console_runs", "select public.console_active_run()", "select public.console_bank_counts()"]) {
        await expect(as(db, role, q), `${role}: ${q}`).rejects.toThrow(/permission denied/);
      }
    }
  });
});
