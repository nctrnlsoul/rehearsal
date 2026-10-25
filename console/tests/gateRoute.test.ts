import { describe, expect, it, vi } from "vitest";
import { type AttemptStore, SESSION_COOKIE, clientIp, dbAttemptStore, verifySession } from "../lib/gate";
import { createDb } from "../lib/db";
import { MAX_BODY_BYTES, handleGatePost } from "../lib/gateRoute";
import { hasValidSession } from "../lib/session";
import { hashFor } from "./helpers";
import { freshDb } from "./pg";
import { TEST_DB_ENV, postgrestOver } from "./postgrest";

const PASS = "a long judge passcode for tests";
const SECRET = "s".repeat(40);
const ENV = { CONSOLE_PASSCODE_HASH: hashFor(PASS), CONSOLE_SESSION_SECRET: SECRET };
const T0 = Date.parse("2026-10-24T12:00:00Z");

function post(body: string, headers: Record<string, string> = {}): Request {
  return new Request("https://console.example.test/api/gate", {
    method: "POST",
    headers: {
      host: "console.example.test",
      origin: "https://console.example.test",
      "content-type": "application/x-www-form-urlencoded",
      "x-vercel-forwarded-for": "203.0.113.10",
      ...headers,
    },
    body,
  });
}

const form = (passcode: string) => `passcode=${encodeURIComponent(passcode)}`;

/**
 * The route against the real gate SQL (migrations/0003) in PGlite, reached
 * through the same HTTP calls it makes to Supabase. The counts therefore run
 * on the database's clock, not T0; T0 only signs the session cookie.
 */
async function harness(env: Record<string, string | undefined> = ENV, global = 50) {
  const pg = await freshDb();
  const rest = postgrestOver(pg);
  const db = createDb({ url: new URL(TEST_DB_ENV.SUPABASE_URL), key: TEST_DB_ENV.SUPABASE_SERVICE_ROLE_KEY }, { fetchImpl: rest.fetch });
  const attempts: AttemptStore = dbAttemptStore(db, SECRET, { perIp: 5, global, windowMs: 3_600_000 });
  const globalFailures = async () =>
    (await pg.query<{ count: number }>("select count from public.console_counters where scope = 'gate_global'")).rows[0]?.count ?? 0;
  const ipLeft = async (ip: string) => {
    const c = await attempts.check(clientIp(new Headers({ "x-vercel-forwarded-for": ip })));
    return c.allowed ? c.ipLeft : 0;
  };
  return { deps: { env, attempts, now: () => T0 }, pg, rest, globalFailures, ipLeft };
}

describe("POST /api/gate", () => {
  it("lets the right passcode in with a signed session cookie", async () => {
    const { deps } = await harness();
    const res = await handleGatePost(post(form(PASS)), deps);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/live");
    const cookie = res.headers.get("set-cookie")!;
    expect(cookie.startsWith(`${SESSION_COOKIE}=`)).toBe(true);
    const token = cookie.split(";")[0]!.split("=").slice(1).join("=");
    expect(verifySession(token, SECRET, T0)).toBe(true);
    expect(hasValidSession(token, ENV, T0)).toBe(true);
  });

  it("refuses a wrong passcode, counts it, and sets no cookie", async () => {
    const { deps } = await harness();
    const res = await handleGatePost(post(form("not it")), deps);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/gate?e=wrong&left=4");
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("locks an IP out after 5 wrong tries, even when the 6th is right", async () => {
    const { deps } = await harness();
    for (let i = 0; i < 5; i += 1) await handleGatePost(post(form("not it")), deps);
    const res = await handleGatePost(post(form(PASS)), deps);
    expect(res.headers.get("location")).toBe("/gate?e=locked&m=60");
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("keys the lockout by IP: another IP still gets in", async () => {
    const { deps } = await harness();
    for (let i = 0; i < 5; i += 1) await handleGatePost(post(form("not it")), deps);
    const res = await handleGatePost(post(form(PASS), { "x-vercel-forwarded-for": "203.0.113.11" }), deps);
    expect(res.headers.get("location")).toBe("/live");
  });

  // R-036: about 10 addresses x 5 wrong tries used to close the gate for every judge.
  it("lets the right passcode in past the global ceiling", async () => {
    // A small ceiling keeps this fast: each wrong try is a real scrypt hash.
    const { deps, globalFailures } = await harness(ENV, 3);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (let i = 0; i < 4; i += 1) await handleGatePost(post(form("x"), { "x-vercel-forwarded-for": `198.51.100.${i}` }), deps);
    expect(await globalFailures()).toBe(4);
    expect(warn).toHaveBeenCalledTimes(1);
    const res = await handleGatePost(post(form(PASS), { "x-vercel-forwarded-for": "203.0.113.200" }), deps);
    expect(res.headers.get("location")).toBe("/live");
    expect(res.headers.get("set-cookie")).not.toBeNull();
  });

  it("past the global ceiling, a wrong passcode is still wrong and still counted", async () => {
    const { deps, globalFailures } = await harness(ENV, 3);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    for (let i = 0; i < 3; i += 1) await handleGatePost(post(form("x"), { "x-vercel-forwarded-for": `198.51.100.${i}` }), deps);
    const res = await handleGatePost(post(form("still not it"), { "x-vercel-forwarded-for": "203.0.113.201" }), deps);
    expect(res.headers.get("location")).toBe("/gate?e=wrong&left=4");
    expect(await globalFailures()).toBe(4);
  });

  // M2 (audit 2026-10-25): a client that sets a fresh X-Forwarded-For on every
  // try must still be counted as one caller.
  it("a spoofed X-Forwarded-For cannot dodge the per-address limit", async () => {
    const { deps } = await harness();
    for (let i = 0; i < 5; i += 1) {
      await handleGatePost(post(form("not it"), { "x-forwarded-for": `198.51.100.${i}`, "x-real-ip": `198.51.100.${100 + i}` }), deps);
    }
    const res = await handleGatePost(post(form(PASS), { "x-forwarded-for": "192.0.2.77", "x-real-ip": "192.0.2.78" }), deps);
    expect(res.headers.get("location")).toBe("/gate?e=locked&m=60");
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("with no Vercel header, spoofed forwarding headers all share one bucket", async () => {
    const { deps } = await harness();
    const bare = (passcode: string, i: number) => {
      const req = post(form(passcode), { "x-forwarded-for": `198.51.100.${i}` });
      req.headers.delete("x-vercel-forwarded-for");
      return req;
    };
    for (let i = 0; i < 5; i += 1) await handleGatePost(bare("not it", i), deps);
    const res = await handleGatePost(bare(PASS, 99), deps);
    expect(res.headers.get("location")).toBe("/gate?e=locked&m=60");
  });

  it("counts one IPv6 /64 as one caller", async () => {
    const { deps } = await harness();
    for (let i = 0; i < 5; i += 1) {
      await handleGatePost(post(form("not it"), { "x-vercel-forwarded-for": `2001:db8:aa:bb::${i + 1}` }), deps);
    }
    const res = await handleGatePost(post(form(PASS), { "x-vercel-forwarded-for": "2001:db8:aa:bb:ffff::1" }), deps);
    expect(res.headers.get("location")).toBe("/gate?e=locked&m=60");
    const next = await handleGatePost(post(form(PASS), { "x-vercel-forwarded-for": "2001:db8:aa:bc::1" }), deps);
    expect(next.headers.get("location")).toBe("/live");
  });

  it("stays closed without a valid hash or secret, and opens nothing", async () => {
    for (const env of [
      { CONSOLE_SESSION_SECRET: SECRET },
      { CONSOLE_PASSCODE_HASH: ENV.CONSOLE_PASSCODE_HASH },
      { CONSOLE_PASSCODE_HASH: PASS, CONSOLE_SESSION_SECRET: SECRET },
      { CONSOLE_PASSCODE_HASH: ENV.CONSOLE_PASSCODE_HASH, CONSOLE_SESSION_SECRET: "short" },
    ]) {
      const res = await handleGatePost(post(form(PASS)), (await harness(env)).deps);
      expect(res.headers.get("location")).toBe("/gate?e=closed");
      expect(res.headers.get("set-cookie")).toBeNull();
    }
  });

  // A refusal is a redirect a browser can follow back to the gate, never a bare
  // body, and it must reach neither the hash nor the attempt count.
  async function expectRefused(req: Request) {
    const hashed: string[] = [];
    const { deps, ipLeft } = await harness();
    const res = await handleGatePost(req, { ...deps, verify: (input: string) => (hashed.push(input), true) });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/gate?e=refused");
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(hashed).toEqual([]);
    expect(await ipLeft("203.0.113.10")).toBe(5);
  }

  it("refuses a cross-site, missing or malformed Origin", async () => {
    for (const origin of ["https://evil.example.test", "null", "not a url"]) {
      await expectRefused(post(form(PASS), { origin }));
    }
    const noOrigin = post(form(PASS));
    noOrigin.headers.delete("origin");
    await expectRefused(noOrigin);
  });

  it("refuses an oversized body, by header or by content", async () => {
    await expectRefused(post(form(PASS), { "content-length": String(MAX_BODY_BYTES + 1) }));
    await expectRefused(post(form("x".repeat(MAX_BODY_BYTES + 10))));
  });

  it("stops reading a chunked body with no length once it passes the cap", async () => {
    const hashed: string[] = [];
    const { deps } = await harness();
    let pulled = 0;
    const chunk = new TextEncoder().encode("x".repeat(1024));
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        pulled += 1;
        if (pulled > 1000) c.close();
        else c.enqueue(chunk);
      },
    });
    const req = new Request("https://console.example.test/api/gate", {
      method: "POST",
      headers: { host: "console.example.test", origin: "https://console.example.test" },
      body: stream,
      duplex: "half",
    } as RequestInit);
    expect(req.headers.get("content-length")).toBeNull();
    const res = await handleGatePost(req, { ...deps, verify: (input: string) => (hashed.push(input), false) });
    expect(res.headers.get("location")).toBe("/gate?e=refused");
    expect(pulled).toBeLessThan(10);
    expect(hashed).toEqual([]);
  });

  it("treats an empty or overlong passcode as wrong, without hashing it", async () => {
    const hashed: string[] = [];
    const { deps } = await harness();
    const spy = { ...deps, verify: (input: string) => (hashed.push(input), false) };
    expect((await handleGatePost(post("passcode="), spy)).headers.get("location")).toBe("/gate?e=wrong&left=4");
    expect((await handleGatePost(post(form("y".repeat(257))), spy)).headers.get("location")).toBe("/gate?e=wrong&left=3");
    expect(hashed).toEqual([]);
    await handleGatePost(post(form("y".repeat(256))), spy);
    expect(hashed).toHaveLength(1);
  });

  it("never sends the passcode, the hash or the secret back", async () => {
    const { deps } = await harness();
    for (const res of [await handleGatePost(post(form(PASS)), deps), await handleGatePost(post(form("nope")), deps)]) {
      const all = `${res.headers.get("location")} ${res.headers.get("set-cookie")} ${await res.text()}`;
      expect(all).not.toContain(PASS);
      expect(all).not.toContain(SECRET);
      expect(all).not.toContain(ENV.CONSOLE_PASSCODE_HASH.split("$")[2]!);
    }
  });

  // R-038: the shared count is the lockout. Without it the gate must not
  // take a guess it cannot count, and it must not hash one either.
  it("stays shut, without hashing, when the console has no database", async () => {
    const hashed: string[] = [];
    const { deps } = await harness();
    const res = await handleGatePost(post(form(PASS)), { ...deps, attempts: null, verify: (i: string) => (hashed.push(i), true) });
    expect(res.headers.get("location")).toBe("/gate?e=unavailable");
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(hashed).toEqual([]);
  });

  it("stays shut, without hashing, when the database does not answer", async () => {
    const hashed: string[] = [];
    const { deps, rest } = await harness();
    rest.down = true;
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await handleGatePost(post(form(PASS)), { ...deps, verify: (i: string) => (hashed.push(i), true) });
    expect(res.headers.get("location")).toBe("/gate?e=unavailable");
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(hashed).toEqual([]);
  });

  it("does not report tries left when a wrong try could not be counted", async () => {
    const { deps } = await harness();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const failing: AttemptStore = {
      check: deps.attempts.check,
      recordFailure: async () => {
        throw new Error("down");
      },
      recordSuccess: deps.attempts.recordSuccess,
    };
    const res = await handleGatePost(post(form("not it")), { ...deps, attempts: failing });
    expect(res.headers.get("location")).toBe("/gate?e=unavailable");
  });

  it("refuses an answer it cannot read as a lockout, never as allowed", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    for (const answer of [[], [{}], [{ allowed: "true", ip_left: 5 }], [{ allowed: true }], { allowed: true, ip_left: 5 }, null]) {
      const db = { rpc: async () => answer };
      const res = await handleGatePost(post(form(PASS)), { env: ENV, attempts: dbAttemptStore(db, SECRET), now: () => T0 });
      expect(res.headers.get("location"), JSON.stringify(answer)).toBe("/gate?e=unavailable");
    }
  });

  it("counts every server instance in one place: a new route instance sees the old count", async () => {
    const first = await harness();
    for (let i = 0; i < 5; i += 1) await handleGatePost(post(form("not it")), first.deps);
    // A second store over the same database is what a fresh Vercel instance gets.
    const db = createDb({ url: new URL(TEST_DB_ENV.SUPABASE_URL), key: TEST_DB_ENV.SUPABASE_SERVICE_ROLE_KEY }, { fetchImpl: first.rest.fetch });
    const res = await handleGatePost(post(form(PASS)), { ...first.deps, attempts: dbAttemptStore(db, SECRET) });
    expect(res.headers.get("location")).toBe("/gate?e=locked&m=60");
  });

  it("never stores the caller's address, only its hash", async () => {
    const { deps, pg } = await harness();
    await handleGatePost(post(form("not it"), { "x-vercel-forwarded-for": "203.0.113.10" }), deps);
    const rows = await pg.query<{ key: string }>("select key from public.console_counters");
    expect(rows.rows.length).toBe(2);
    for (const r of rows.rows) expect(r.key).not.toContain("203.0.113");
  });
});

describe("hasValidSession", () => {
  it("is false without a secret, a cookie, or a signature from this server", () => {
    expect(hasValidSession(undefined, ENV, T0)).toBe(false);
    expect(hasValidSession("v1.9999999999.abcdefghijklmnop.forged", ENV, T0)).toBe(false);
    expect(hasValidSession("anything", {}, T0)).toBe(false);
  });
});
