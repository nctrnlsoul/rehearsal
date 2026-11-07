import { describe, expect, it, vi } from "vitest";
import plans from "../fixtures/plans.json";
import { createDb } from "../lib/db";
import type { GenerateFn, Scenario } from "../lib/engine";
import { SESSION_COOKIE, signSession } from "../lib/gate";
import {
  HOSTED_FINDER_CLASSES,
  PLAN_BODY_MAX_BYTES,
  type FinderDeps,
  type RunsDeps,
  handleBankGet,
  handleFinderPost,
  handleDryRunPost,
  handlePlanPost,
  handleRunGet,
  handleRunsPost,
} from "../lib/live";
import { freshDb } from "./pg";
import { TEST_DB_ENV, postgrestOver } from "./postgrest";

/**
 * The live routes against the real SQL in PGlite, through the same HTTP calls
 * they make to Supabase. Stubbed, so NOT tested here: the model (a function
 * returning text), PayPal (the worker is replaced by a recorder; its own tests
 * cover it), Next's after(), and Vercel.
 */

const SECRET = "s".repeat(40);
const T0 = Date.parse("2026-10-25T18:00:00Z");
const STORE = "https://rehearsal-store.vercel.app";
const ENV = { ...TEST_DB_ENV, CONSOLE_SESSION_SECRET: SECRET, CONSOLE_LIVE_RUNS: "on", REHEARSAL_STORE_ORIGIN: STORE };
const [BAKERY, DISPUTE] = plans.plans as unknown as Array<{ plan: string; sha256: string; scenario: Scenario }>;

const cookieFor = (nowMs = T0) => `${SESSION_COOKIE}=${signSession(SECRET, nowMs)}`;

function req(path: string, opts: { method?: string; body?: unknown; raw?: string; headers?: Record<string, string>; cookie?: string | null } = {}) {
  const method = opts.method ?? (opts.body !== undefined || opts.raw !== undefined ? "POST" : "GET");
  return new Request(`https://console.example.test${path}`, {
    method,
    headers: {
      host: "console.example.test",
      origin: "https://console.example.test",
      "content-type": "application/json",
      "x-vercel-forwarded-for": "203.0.113.10",
      ...(opts.cookie === null ? {} : { cookie: opts.cookie ?? cookieFor() }),
      ...(opts.headers ?? {}),
    },
    ...(method === "GET" ? {} : { body: opts.raw ?? JSON.stringify(opts.body) }),
  });
}

const simpleScenario = {
  version: 1,
  name: "Candle Shop",
  profile: { name: "Candle Shop" },
  currency: "USD",
  steps: [{ id: "order-1", kind: "card_order", amount: "25.00", needs: [] }],
};

async function harness(env: Record<string, string | undefined> = ENV) {
  const pg = await freshDb();
  const rest = postgrestOver(pg);
  const db = createDb({ url: new URL(TEST_DB_ENV.SUPABASE_URL), key: TEST_DB_ENV.SUPABASE_SERVICE_ROLE_KEY }, { fetchImpl: rest.fetch });
  const modelCalls: string[] = [];
  let reply = JSON.stringify(simpleScenario);
  const generate: GenerateFn = async ({ prompt }) => {
    modelCalls.push(prompt);
    return { text: reply, usage: { inputTokens: 10, outputTokens: 10 } };
  };
  const started: Array<{ runId: string; scenario: Scenario; digest: string }> = [];
  const base = { env, db, now: () => T0 };
  return {
    pg,
    rest,
    modelCalls,
    started,
    setReply: (r: string) => (reply = r),
    plan: (r: Request, over: Partial<{ generate: GenerateFn | null }> = {}) => handlePlanPost(r, { ...base, generate, ...over }),
    dry: (r: Request) => handleDryRunPost(r, base),
    runs: (r: Request, over: Partial<{ paypalReady: boolean; startWorker: RunsDeps["startWorker"] }> = {}) =>
      handleRunsPost(r, { ...base, paypalReady: true, startWorker: (a) => started.push(a), ...over }),
    get: (r: Request, id: string) => handleRunGet(r, id, base),
    bank: (r: Request) => handleBankGet(r, base),
    used: async (scope: string, key = "all") =>
      (await pg.query<{ n: number }>("select public.console_daily_used($1, $2) as n", [scope, key])).rows[0]!.n,
    addPurchase: () =>
      pg.exec(`insert into public.console_purchases (order_id, capture_id, buyer_transaction_id, amount, currency, created_at)
               values ('O-${Math.random().toString(16).slice(2, 10)}', 'C-1', 'T-1', '25.00', 'USD', now())`),
  };
}

const runBody = (p: { plan: string; sha256: string }, over: Record<string, unknown> = {}) => ({
  source: "recorded",
  planId: p.plan,
  sha256: p.sha256,
  confirm: true,
  ...over,
});

const bodyOf = async (r: Response) => (await r.json()) as Record<string, unknown>;

describe("every live route", () => {
  it("refuses without a valid session", async () => {
    const h = await harness();
    const none = { cookie: null };
    expect((await h.plan(req("/api/plan", { body: { description: "x" }, ...none }))).status).toBe(401);
    expect((await h.dry(req("/api/dry-run", { body: { source: "recorded", planId: DISPUTE!.plan }, ...none }))).status).toBe(401);
    expect((await h.runs(req("/api/runs", { body: runBody(DISPUTE!), ...none }))).status).toBe(401);
    expect((await h.get(req("/api/runs/x", none), "20261025000000-000001")).status).toBe(401);
    expect((await h.bank(req("/api/bank", none))).status).toBe(401);
    // A token signed with another secret, or expired, is no session.
    const forged = `${SESSION_COOKIE}=${signSession("t".repeat(40), T0)}`;
    expect((await h.bank(req("/api/bank", { cookie: forged })))).toHaveProperty("status", 401);
    const expired = cookieFor(T0 - 3 * 60 * 60 * 1000);
    expect((await h.bank(req("/api/bank", { cookie: expired })))).toHaveProperty("status", 401);
  });

  // One test per value: five harnesses in one test took 10 s of its 15 s
  // budget on a loaded machine, and timed out for reasons unrelated to it.
  it.each([undefined, "", "off", "ON", "true"])("refuses writes while the kill switch is %j", async (value) => {
    const h = await harness({ ...ENV, CONSOLE_LIVE_RUNS: value });
    expect((await h.plan(req("/api/plan", { body: { description: "a shop" } }))).status).toBe(503);
    expect((await h.runs(req("/api/runs", { body: runBody(DISPUTE!) }))).status).toBe(503);
    expect((await h.dry(req("/api/dry-run", { body: { source: "recorded", planId: DISPUTE!.plan } }))).status).toBe(200);
    expect(h.modelCalls).toEqual([]);
    expect(h.started).toEqual([]);
  });

  it("still lets a run be watched while the kill switch is off", async () => {
    const h = await harness({ ...ENV, CONSOLE_LIVE_RUNS: undefined });
    expect((await h.get(req("/api/runs/20261025000000-000001"), "20261025000000-000001")).status).toBe(404);
    expect((await h.bank(req("/api/bank"))).status).toBe(200);
  });

  it("refuses when hosted runs are not configured, or another event origin is set", async () => {
    for (const env of [
      { ...ENV, REHEARSAL_STORE_ORIGIN: undefined },
      { ...ENV, REHEARSAL_RECEIVER_ORIGIN: "https://receiver-lyart.vercel.app" },
      { ...ENV, REHEARSAL_EVENT_ORIGINS: "https://elsewhere.example" },
      { ...ENV, CONSOLE_MAX_RUNS_PER_DAY: "lots" },
    ]) {
      const h = await harness(env);
      const r = await h.runs(req("/api/runs", { body: runBody(DISPUTE!) }));
      expect(r.status).toBe(503);
      expect(JSON.stringify(await r.json())).not.toContain("receiver-lyart");
    }
  });

  it("refuses without a database, and when the database does not answer", async () => {
    const h = await harness();
    const noDb = await handleBankGet(req("/api/bank"), { env: ENV, db: null, now: () => T0 });
    expect(noDb.status).toBe(503);
    h.rest.down = true;
    expect((await h.bank(req("/api/bank"))).status).toBe(503);
    expect((await h.runs(req("/api/runs", { body: runBody(DISPUTE!) }))).status).toBe(503);
    expect(h.started).toEqual([]);
  });

  it("refuses a cross-site post, the wrong content type, a large body and unknown fields", async () => {
    const h = await harness();
    expect((await h.runs(req("/api/runs", { body: runBody(DISPUTE!), headers: { origin: "https://evil.example" } }))).status).toBe(403);
    expect((await h.runs(req("/api/runs", { body: runBody(DISPUTE!), headers: { "content-type": "text/plain" } }))).status).toBe(415);
    expect((await h.runs(req("/api/runs", { body: runBody(DISPUTE!), headers: { "content-length": "5000" } }))).status).toBe(413);
    expect((await h.runs(req("/api/runs", { raw: JSON.stringify({ ...runBody(DISPUTE!), pad: "x".repeat(2000) }) }))).status).toBe(413);
    expect((await h.runs(req("/api/runs", { body: { ...runBody(DISPUTE!), scenario: simpleScenario } }))).status).toBe(400);
    expect((await h.runs(req("/api/runs", { raw: "not json" }))).status).toBe(400);
    expect((await h.runs(req("/api/runs", { raw: "[1,2]" }))).status).toBe(400);
    expect(h.started).toEqual([]);
  });
});

describe("POST /api/plan", () => {
  it("makes one model call, saves the plan, and returns its id, digest and dry run", async () => {
    const h = await harness();
    const r = await h.plan(req("/api/plan", { body: { description: "  a candle shop that takes card orders  " } }));
    expect(r.status).toBe(200);
    const b = await bodyOf(r);
    expect(h.modelCalls).toHaveLength(1);
    expect(b["planId"]).toMatch(/^[0-9a-f-]{36}$/);
    const dry = b["dryRun"] as Record<string, unknown>;
    expect(dry["ok"]).toBe(true);
    expect(dry["sha256"]).toMatch(/^[0-9a-f]{64}$/);
    expect(dry["budgetS"]).toBe(63);
    const saved = await h.pg.query<{ description: string; sha256: string }>("select description, sha256 from public.console_plans");
    expect(saved.rows).toEqual([{ description: "a candle shop that takes card orders", sha256: dry["sha256"] }]);
    expect(await h.used("model_global")).toBe(1);
  });

  it("refuses an empty or over-long description before any model call", async () => {
    const h = await harness();
    for (const description of ["", "   ", "x".repeat(2001), 42]) {
      expect((await h.plan(req("/api/plan", { body: { description } }))).status).toBe(400);
    }
    expect((await h.plan(req("/api/plan", { body: { description: "x".repeat(2000) } }))).status).toBe(200);
    expect(h.modelCalls).toHaveLength(1);
  });

  it("refuses a body over 8 KB", async () => {
    const h = await harness();
    const r = await h.plan(req("/api/plan", { raw: JSON.stringify({ description: "é".repeat(PLAN_BODY_MAX_BYTES / 2) }) }));
    expect(r.status).toBe(413);
    expect(h.modelCalls).toEqual([]);
  });

  it("spends no quota when no model key is configured", async () => {
    const h = await harness();
    expect((await h.plan(req("/api/plan", { body: { description: "a shop" } }), { generate: null })).status).toBe(503);
    expect(await h.used("model_global")).toBe(0);
  });

  // R-049: judges behind one corporate exit share an address, so a second
  // judge's session on the same address must get its own share.
  it("refuses at the per-session limit, but a new session from the same address still plans (R-049)", async () => {
    const h = await harness({ ...ENV, CONSOLE_MAX_MODEL_CALLS_PER_SESSION: "2" });
    const mine = cookieFor();
    for (let i = 0; i < 2; i += 1) expect((await h.plan(req("/api/plan", { body: { description: "a shop" }, cookie: mine }))).status).toBe(200);
    const third = await h.plan(req("/api/plan", { body: { description: "a shop" }, cookie: mine }));
    expect(third.status).toBe(429);
    expect((await bodyOf(third))["limit"]).toBe("model_session");
    const colleague = await h.plan(req("/api/plan", { body: { description: "a shop" }, cookie: cookieFor(T0 + 1000) }));
    expect(colleague.status).toBe(200);
    expect(h.modelCalls).toHaveLength(3);
  });

  it("refuses at the global limit with copy that says recorded plans still run", async () => {
    const h = await harness({ ...ENV, CONSOLE_MAX_MODEL_CALLS_PER_DAY: "1" });
    await h.plan(req("/api/plan", { body: { description: "a shop" } }));
    const r = await h.plan(req("/api/plan", { body: { description: "a shop" }, headers: { "x-vercel-forwarded-for": "198.51.100.7" }, cookie: cookieFor(T0 + 5) }));
    expect(r.status).toBe(429);
    const b = await bodyOf(r);
    expect(b["limit"]).toBe("model_global");
    expect(String(b["error"])).toContain("The recorded plans still run.");
  });

  it("saves nothing when the model's answer fails the checks, and the call stays counted", async () => {
    const h = await harness();
    h.setReply(JSON.stringify({ ...simpleScenario, steps: [{ id: "o", kind: "card_order", amount: "900.00", needs: [] }] }));
    const r = await h.plan(req("/api/plan", { body: { description: "a big shop" } }));
    expect(r.status).toBe(422);
    expect((await bodyOf(r))["reason"]).toBe("over-caps");
    h.setReply("I would rather not");
    expect((await h.plan(req("/api/plan", { body: { description: "a shop" } }))).status).toBe(422);
    expect((await h.pg.query("select * from public.console_plans")).rows).toEqual([]);
    expect(await h.used("model_global")).toBe(2);
  });

  it("refuses a webhook the model aims anywhere but the store", async () => {
    const h = await harness();
    h.setReply(JSON.stringify({ ...simpleScenario, webhook: { target: "https://evil.example/api/paypal/webhook", eventTypes: ["PAYMENT.CAPTURE.COMPLETED"] } }));
    const r = await h.plan(req("/api/plan", { body: { description: "a shop" } }));
    expect(r.status).toBe(422);
    expect((await h.pg.query("select * from public.console_plans")).rows).toEqual([]);
  });
});

describe("POST /api/dry-run", () => {
  it("shows a recorded dispute plan as blocked on an empty bank, and runnable with one purchase", async () => {
    const h = await harness();
    const before = await bodyOf(await h.dry(req("/api/dry-run", { body: { source: "recorded", planId: DISPUTE!.plan } })));
    expect(before).toMatchObject({ ok: false, sha256: DISPUTE!.sha256, budgetS: 239, bank: { needed: 1, available: 0, short: true } });
    await h.addPurchase();
    const after = await bodyOf(await h.dry(req("/api/dry-run", { body: { source: "recorded", planId: DISPUTE!.plan } })));
    expect(after).toMatchObject({ ok: true, bank: { needed: 1, available: 1, short: false } });
    expect((after["lines"] as string[]).length).toBeGreaterThan(0);
  });

  // R-043: Tiny Bakery runs hosted. It draws nothing from the bank.
  it("passes Tiny Bakery with its own digest, no bank draw and a 487 s budget", async () => {
    const h = await harness();
    const b = await bodyOf(await h.dry(req("/api/dry-run", { body: { source: "recorded", planId: BAKERY!.plan } })));
    expect(b).toMatchObject({ ok: true, sha256: BAKERY!.sha256, budgetS: 487, errors: [], bank: { needed: 0, short: false } });
    // R-045: it declares no webhook, and the dry run no longer says that stops deliveries.
    const lines = (b["lines"] as string[]).join(" | ");
    expect(lines).toContain("none declared by this plan; PayPal still delivers this account's events to every webhook registered on it");
    expect(lines).not.toMatch(/no events will be delivered/i);
  });

  it("finds no plan for an unknown id, a malformed uuid, or an unknown source", async () => {
    const h = await harness();
    for (const body of [
      { source: "recorded", planId: "plan-nope" },
      { source: "planned", planId: "not-a-uuid" },
      { source: "planned", planId: "00000000-0000-0000-0000-000000000000" },
      { source: "../bank", planId: DISPUTE!.plan },
    ]) {
      expect((await h.dry(req("/api/dry-run", { body }))).status, JSON.stringify(body)).toBe(404);
    }
  });
});

describe("POST /api/runs", () => {
  it("starts the exact recorded plan: 202, one run row, and the worker gets the gated scenario", async () => {
    const h = await harness();
    await h.addPurchase();
    const r = await h.runs(req("/api/runs", { body: runBody(DISPUTE!) }));
    expect(r.status).toBe(202);
    const { runId } = await bodyOf(r);
    expect(runId).toMatch(/^\d{14}-[0-9a-f]{6}$/);
    expect(h.started).toHaveLength(1);
    expect(h.started[0]!.runId).toBe(runId);
    expect(h.started[0]!.digest).toBe(DISPUTE!.sha256);
    const row = await h.pg.query<{ status: string; scenario_sha256: string; plan_id: string }>("select status, scenario_sha256, plan_id from public.console_runs");
    expect(row.rows).toEqual([{ status: "queued", scenario_sha256: DISPUTE!.sha256, plan_id: DISPUTE!.plan }]);
    expect(await h.used("runs_global")).toBe(1);
  });

  it("runs a planned plan by id, recomputing its digest from what the database holds", async () => {
    const h = await harness();
    const planned = await bodyOf(await h.plan(req("/api/plan", { body: { description: "a candle shop" } })));
    const sha = (planned["dryRun"] as Record<string, string>)["sha256"]!;
    const r = await h.runs(req("/api/runs", { body: { source: "planned", planId: planned["planId"], sha256: sha, confirm: true } }));
    expect(r.status).toBe(202);
    expect(h.started[0]!.digest).toBe(sha);
  });

  it("refuses a digest that is not the plan's, and starts nothing", async () => {
    const h = await harness();
    await h.addPurchase();
    const r = await h.runs(req("/api/runs", { body: runBody(DISPUTE!, { sha256: "0".repeat(64) }) }));
    expect(r.status).toBe(409);
    expect(h.started).toEqual([]);
    expect(await h.used("runs_global")).toBe(0);
  });

  it("refuses a saved plan whose stored digest does not match its scenario", async () => {
    const h = await harness();
    const id = (await h.pg.query<{ id: string }>(
      `select public.console_save_plan('${"b".repeat(64)}', 'a shop', $1::jsonb, '${"a".repeat(64)}') as id`,
      [JSON.stringify(simpleScenario)],
    )).rows[0]!.id;
    const r = await h.runs(req("/api/runs", { body: { source: "planned", planId: id, sha256: "a".repeat(64), confirm: true } }));
    expect(r.status).toBe(409);
    // Verifier finding: the stored-digest clause was never tested alone, because
    // the browser always sent the stored value. Here it sends the digest the
    // server recomputes, so only the stored one disagrees.
    const recomputed = (await bodyOf(await h.dry(req("/api/dry-run", { body: { source: "planned", planId: id } }))))["sha256"];
    expect(recomputed).toMatch(/^[0-9a-f]{64}$/);
    expect(recomputed).not.toBe("a".repeat(64));
    const r2 = await h.runs(req("/api/runs", { body: { source: "planned", planId: id, sha256: recomputed, confirm: true } }));
    expect(r2.status).toBe(409);
    expect(h.started).toEqual([]);
    expect(await h.used("runs_global")).toBe(0);
  });

  // Verifier finding: a hand-off that threw answered 503 but left the run
  // queued, holding the one slot for 60 s and spending a run.
  it("gives the run and its quota back when the worker cannot be handed the run", async () => {
    const h = await harness();
    await h.addPurchase();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await h.runs(req("/api/runs", { body: runBody(DISPUTE!) }), {
      startWorker: () => {
        throw new Error("after() outside a request");
      },
    });
    expect(r.status).toBe(503);
    expect(await h.used("runs_global")).toBe(0);
    const spent = (await h.pg.query<{ n: number }>("select coalesce(sum(count), 0)::int as n from public.console_counters")).rows[0]!.n;
    expect(spent).toBe(0);
    const rows = (await h.pg.query<{ status: string }>("select status from public.console_runs")).rows;
    expect(rows).toEqual([{ status: "abandoned" }]);
    // The slot is free at once.
    expect((await h.runs(req("/api/runs", { body: runBody(DISPUTE!) }))).status).toBe(202);
  });

  it("refuses without confirm: true, or with a malformed digest", async () => {
    const h = await harness();
    for (const over of [{ confirm: false }, { confirm: "true" }, { sha256: "abc" }, { sha256: 7 }]) {
      expect((await h.runs(req("/api/runs", { body: runBody(DISPUTE!, over) }))).status, JSON.stringify(over)).toBe(400);
    }
    expect(h.started).toEqual([]);
  });

  it("refuses a dispute plan on an empty bank before spending a run", async () => {
    const h = await harness();
    const r = await h.runs(req("/api/runs", { body: runBody(DISPUTE!) }));
    expect(r.status).toBe(409);
    expect((await bodyOf(r))["bank"]).toEqual({ needed: 1, available: 0, short: true });
    expect(await h.used("runs_global")).toBe(0);
  });

  it("starts Tiny Bakery, bound to its recorded digest", async () => {
    const h = await harness();
    const r = await h.runs(req("/api/runs", { body: runBody(BAKERY!) }));
    expect(r.status).toBe(202);
    expect(h.started[0]!.digest).toBe(BAKERY!.sha256);
    expect(h.started[0]!.scenario.steps.map((s) => s.kind)).toEqual(["card_order", "card_order", "invoice_create", "invoice_send", "invoice_record_payment"]);
  });

  it("refuses a plan over the hosted caps, and spends nothing", async () => {
    const h = await harness();
    // Saved straight into the table: the planner route never saves a plan over the caps.
    const over = { ...simpleScenario, steps: [{ id: "o", kind: "card_order", amount: "150.01", needs: [] }] };
    const id = (await h.pg.query<{ id: string }>(
      `select public.console_save_plan('${"b".repeat(64)}', 'a shop', $1::jsonb, '${"a".repeat(64)}') as id`,
      [JSON.stringify(over)],
    )).rows[0]!.id;
    const r = await h.runs(req("/api/runs", { body: { source: "planned", planId: id, sha256: "a".repeat(64), confirm: true } }));
    expect(r.status).toBe(422);
    expect(((await bodyOf(r))["reasons"] as string[]).join(" ")).toContain("USD 150.01, over the per-step cap of USD 150.00");
    expect(h.started).toEqual([]);
    expect(await h.used("runs_global")).toBe(0);
  });

  it("refuses without PayPal credentials before spending a run", async () => {
    const h = await harness();
    await h.addPurchase();
    expect((await h.runs(req("/api/runs", { body: runBody(DISPUTE!) }), { paypalReady: false })).status).toBe(503);
    expect(await h.used("runs_global")).toBe(0);
  });

  it("refuses a second run while one is going, and links to it", async () => {
    const h = await harness();
    await h.addPurchase();
    await h.addPurchase();
    const first = await bodyOf(await h.runs(req("/api/runs", { body: runBody(DISPUTE!) })));
    const second = await h.runs(req("/api/runs", { body: runBody(DISPUTE!) }));
    expect(second.status).toBe(409);
    expect((await bodyOf(second))["activeRunId"]).toBe(first["runId"]);
    expect(h.started).toHaveLength(1);
    expect(await h.used("runs_global")).toBe(1);
  });

  it("refuses at the session limit, but a new session from the same address still runs (R-049)", async () => {
    const h = await harness({ ...ENV, CONSOLE_MAX_RUNS_PER_SESSION: "1" });
    for (let i = 0; i < 3; i += 1) await h.addPurchase();
    const mine = cookieFor();
    expect((await h.runs(req("/api/runs", { body: runBody(DISPUTE!), cookie: mine }))).status).toBe(202);
    await h.pg.exec("update public.console_runs set status = 'complete'");
    const again = await h.runs(req("/api/runs", { body: runBody(DISPUTE!), cookie: mine }));
    expect(again.status).toBe(429);
    expect((await bodyOf(again))["limit"]).toBe("runs_session");
    const colleague = await h.runs(req("/api/runs", { body: runBody(DISPUTE!), cookie: cookieFor(T0 + 1000) }));
    expect(colleague.status).toBe(202);
    expect(h.started).toHaveLength(2);
  });
});

describe("GET /api/runs/[runId]", () => {
  it("returns the run and its events after a cursor, never the hashes", async () => {
    const h = await harness();
    await h.addPurchase();
    const { runId } = await bodyOf(await h.runs(req("/api/runs", { body: runBody(DISPUTE!) })));
    await h.pg.query(`select public.console_mark_running('${runId}')`);
    const r = await h.get(req(`/api/runs/${runId}`), String(runId));
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    const b = await bodyOf(r);
    expect((b["run"] as Record<string, unknown>)["status"]).toBe("running");
    expect(JSON.stringify(b)).not.toContain("b".repeat(10));
    const events = b["events"] as Array<{ seq: number }>;
    const later = await bodyOf(await h.get(req(`/api/runs/${runId}?after=${events.at(-1)!.seq}`), String(runId)));
    expect(later["events"]).toEqual([]);
  });

  it("refuses a malformed id or cursor, and finds no unknown run", async () => {
    const h = await harness();
    expect((await h.get(req("/api/runs/x"), "../bank/purchases")).status).toBe(404);
    expect((await h.get(req("/api/runs/x?after=-1"), "20261025000000-000001")).status).toBe(400);
    expect((await h.get(req("/api/runs/x?after=1e3"), "20261025000000-000001")).status).toBe(400);
    expect((await h.get(req("/api/runs/x"), "20261025000000-000001")).status).toBe(404);
  });

  it("shows a run whose server died as abandoned on the next poll", async () => {
    const h = await harness();
    await h.addPurchase();
    const { runId } = await bodyOf(await h.runs(req("/api/runs", { body: runBody(DISPUTE!) })));
    await h.pg.query(`select public.console_mark_running('${runId}')`);
    await h.pg.exec(`update public.console_runs set heartbeat_at = now() - interval '91 seconds'`);
    const b = await bodyOf(await h.get(req(`/api/runs/${runId}`), String(runId)));
    expect((b["run"] as Record<string, unknown>)["status"]).toBe("abandoned");
  });
});

describe("GET /api/bank", () => {
  it("returns counts and no ids", async () => {
    const h = await harness();
    await h.addPurchase();
    const r = await h.bank(req("/api/bank"));
    const text = await r.text();
    expect(JSON.parse(text)).toEqual({ available: 1, used: 0 });
    expect(text).not.toMatch(/O-|C-1|T-1/);
  });
});

describe("no route", () => {
  // Second verifier: the check below covered only refusals. These are the
  // answers a judge actually gets.
  it("echoes the session secret, the database key or the database URL when it succeeds", async () => {
    const h = await harness();
    await h.addPurchase();
    const planned = await h.plan(req("/api/plan", { body: { description: "a candle shop" } }));
    const dry = await h.dry(req("/api/dry-run", { body: { source: "recorded", planId: DISPUTE!.plan } }));
    const started = await h.runs(req("/api/runs", { body: runBody(DISPUTE!) }));
    const startedText = await started.text();
    const runId = String((JSON.parse(startedText) as Record<string, unknown>)["runId"]);
    const read = await h.get(req(`/api/runs/${runId}`), runId);
    const bank = await h.bank(req("/api/bank"));
    const f = await harness();
    const finder = await handleFinderPost(req("/api/finder", { body: { classId: "overdue-invoice", confirm: true } }), {
      env: ENV,
      db: createDb({ url: new URL(TEST_DB_ENV.SUPABASE_URL), key: TEST_DB_ENV.SUPABASE_SERVICE_ROLE_KEY }, { fetchImpl: f.rest.fetch }),
      now: () => T0,
      paypalReady: true,
      generate: async () => ({ text: "{}" }),
      startFinder: () => {},
    });
    const responses = [planned, dry, started, read, bank, finder];
    expect(responses.map((r) => r.status)).toEqual([200, 200, 202, 200, 200, 202]);
    for (const r of responses) {
      const text = r === started ? startedText : await r.text();
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain(TEST_DB_ENV.SUPABASE_SERVICE_ROLE_KEY);
      expect(text).not.toContain(TEST_DB_ENV.SUPABASE_URL);
      expect(text).not.toContain("supabase.co");
    }
  });

  it("echoes the session secret, the database key or a store value", async () => {
    const h = await harness();
    h.rest.down = true;
    const responses = [
      await h.bank(req("/api/bank")),
      await h.runs(req("/api/runs", { body: runBody(DISPUTE!) })),
      await h.plan(req("/api/plan", { body: { description: "a shop" } })),
      await h.dry(req("/api/dry-run", { body: { source: "recorded", planId: DISPUTE!.plan } })),
      await h.get(req("/api/runs/20261025000000-000001"), "20261025000000-000001"),
      await handleFinderPost(req("/api/finder", { body: { classId: "overdue-invoice", confirm: true } }), {
        env: ENV,
        db: createDb({ url: new URL(TEST_DB_ENV.SUPABASE_URL), key: TEST_DB_ENV.SUPABASE_SERVICE_ROLE_KEY }, { fetchImpl: h.rest.fetch }),
        now: () => T0,
        paypalReady: true,
        generate: async () => ({ text: "{}" }),
        startFinder: () => {},
      }),
    ];
    expect(responses.map((r) => r.status)).toEqual([503, 503, 503, 503, 503, 503]);
    for (const r of responses) {
      const text = await r.text();
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain(TEST_DB_ENV.SUPABASE_SERVICE_ROLE_KEY);
      expect(text).not.toContain("supabase.co");
      expect(text).not.toContain(TEST_DB_ENV.SUPABASE_URL);
    }
  });
});


describe("POST /api/finder", () => {
  const finderHarness = async (env: Record<string, string | undefined> = ENV) => {
    const h = await harness(env);
    const startedFinders: Array<{ runId: string; classId: string }> = [];
    const generate: GenerateFn = async () => ({ text: "{}" });
    const post = (r: Request, over: Partial<{ paypalReady: boolean; generate: GenerateFn | null; startFinder: FinderDeps["startFinder"] }> = {}) =>
      handleFinderPost(r, {
        env,
        db: createDb({ url: new URL(TEST_DB_ENV.SUPABASE_URL), key: TEST_DB_ENV.SUPABASE_SERVICE_ROLE_KEY }, { fetchImpl: h.rest.fetch }),
        now: () => T0,
        paypalReady: true,
        generate,
        startFinder: (a) => startedFinders.push({ runId: a.runId, classId: a.classId }),
        ...over,
      });
    return { ...h, post, startedFinders };
  };

  it("runs only the supported, template-backed classes that need no bank", () => {
    expect(HOSTED_FINDER_CLASSES).toEqual(["duplicate-webhook", "refund-after-partial", "unclaimed-payout", "overdue-invoice"]);
  });

  it("starts one class, spending one run and one model call", async () => {
    const h = await finderHarness();
    const r = await h.post(req("/api/finder", { body: { classId: "overdue-invoice", confirm: true } }));
    expect(r.status).toBe(202);
    expect(h.startedFinders).toEqual([{ runId: (await bodyOf(r))["runId"], classId: "overdue-invoice" }]);
    expect(await h.used("runs_global")).toBe(1);
    expect(await h.used("model_global")).toBe(1);
  });

  it("refuses an unknown or unsupported class, and more than one class", async () => {
    const h = await finderHarness();
    for (const classId of ["dispute-on-refunded-order", "nope", ["overdue-invoice", "unclaimed-payout"], 1]) {
      expect((await h.post(req("/api/finder", { body: { classId, confirm: true } }))).status, JSON.stringify(classId)).toBe(400);
    }
    expect((await h.post(req("/api/finder", { body: { classId: "overdue-invoice" } }))).status).toBe(400);
    expect(h.startedFinders).toEqual([]);
  });

  it("spends nothing without a model key or PayPal credentials, or with the kill switch off", async () => {
    const h = await finderHarness();
    const body = { classId: "overdue-invoice", confirm: true };
    expect((await h.post(req("/api/finder", { body }), { generate: null })).status).toBe(503);
    expect((await h.post(req("/api/finder", { body }), { paypalReady: false })).status).toBe(503);
    const off = await finderHarness({ ...ENV, CONSOLE_LIVE_RUNS: undefined });
    expect((await off.post(req("/api/finder", { body }))).status).toBe(503);
    expect(await h.used("runs_global")).toBe(0);
    expect(await h.used("model_global")).toBe(0);
  });

  // Second verifier: the finder's hand-off was untested; it could skip the
  // cancel and nothing noticed.
  it("gives the run and the model call back when the worker cannot be handed the class", async () => {
    const h = await finderHarness();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const body = { classId: "overdue-invoice", confirm: true };
    const r = await h.post(req("/api/finder", { body }), {
      startFinder: () => {
        throw new Error("bad credential");
      },
    });
    expect(r.status).toBe(503);
    expect(await h.used("runs_global")).toBe(0);
    expect(await h.used("model_global")).toBe(0);
    expect((await h.pg.query<{ status: string }>("select status from public.console_runs")).rows).toEqual([{ status: "abandoned" }]);
    expect((await h.post(req("/api/finder", { body }))).status).toBe(202);
  });

  it("spends neither the run nor the model call when the model quota is full", async () => {
    const h = await finderHarness({ ...ENV, CONSOLE_MAX_MODEL_CALLS_PER_SESSION: "0" });
    const r = await h.post(req("/api/finder", { body: { classId: "overdue-invoice", confirm: true } }));
    expect(r.status).toBe(429);
    expect((await bodyOf(r))["limit"]).toBe("model_session");
    expect(await h.used("runs_global")).toBe(0);
  });
});
