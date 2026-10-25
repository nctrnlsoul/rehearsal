import { describe, expect, it, vi } from "vitest";
import { AttemptLimiter, SESSION_COOKIE, verifySession } from "../lib/gate";
import { MAX_BODY_BYTES, handleGatePost } from "../lib/gateRoute";
import { hasValidSession } from "../lib/session";
import { hashFor } from "./helpers";

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

function harness(env: Record<string, string | undefined> = ENV, global = 50) {
  const limiter = new AttemptLimiter({ perIp: 5, global, windowMs: 3_600_000 }, () => T0);
  return { deps: { env, limiter, now: () => T0 }, limiter };
}

describe("POST /api/gate", () => {
  it("lets the right passcode in with a signed session cookie", async () => {
    const { deps } = harness();
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
    const { deps } = harness();
    const res = await handleGatePost(post(form("not it")), deps);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/gate?e=wrong&left=4");
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("locks an IP out after 5 wrong tries, even when the 6th is right", async () => {
    const { deps } = harness();
    for (let i = 0; i < 5; i += 1) await handleGatePost(post(form("not it")), deps);
    const res = await handleGatePost(post(form(PASS)), deps);
    expect(res.headers.get("location")).toBe("/gate?e=locked&m=60");
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("keys the lockout by IP: another IP still gets in", async () => {
    const { deps } = harness();
    for (let i = 0; i < 5; i += 1) await handleGatePost(post(form("not it")), deps);
    const res = await handleGatePost(post(form(PASS), { "x-vercel-forwarded-for": "203.0.113.11" }), deps);
    expect(res.headers.get("location")).toBe("/live");
  });

  // R-036: about 10 addresses x 5 wrong tries used to close the gate for every judge.
  it("lets the right passcode in past the global ceiling", async () => {
    // A small ceiling keeps this fast: each wrong try is a real scrypt hash.
    const { deps, limiter } = harness(ENV, 3);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (let i = 0; i < 4; i += 1) await handleGatePost(post(form("x"), { "x-vercel-forwarded-for": `198.51.100.${i}` }), deps);
    expect(limiter.globalFailures).toBe(4);
    expect(warn).toHaveBeenCalledTimes(1);
    const res = await handleGatePost(post(form(PASS), { "x-vercel-forwarded-for": "203.0.113.200" }), deps);
    expect(res.headers.get("location")).toBe("/live");
    expect(res.headers.get("set-cookie")).not.toBeNull();
  });

  it("past the global ceiling, a wrong passcode is still wrong and still counted", async () => {
    const { deps, limiter } = harness(ENV, 3);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    for (let i = 0; i < 3; i += 1) await handleGatePost(post(form("x"), { "x-vercel-forwarded-for": `198.51.100.${i}` }), deps);
    const res = await handleGatePost(post(form("still not it"), { "x-vercel-forwarded-for": "203.0.113.201" }), deps);
    expect(res.headers.get("location")).toBe("/gate?e=wrong&left=4");
    expect(limiter.globalFailures).toBe(4);
  });

  // M2 (audit 2026-10-25): a client that sets a fresh X-Forwarded-For on every
  // try must still be counted as one caller.
  it("a spoofed X-Forwarded-For cannot dodge the per-address limit", async () => {
    const { deps } = harness();
    for (let i = 0; i < 5; i += 1) {
      await handleGatePost(post(form("not it"), { "x-forwarded-for": `198.51.100.${i}`, "x-real-ip": `198.51.100.${100 + i}` }), deps);
    }
    const res = await handleGatePost(post(form(PASS), { "x-forwarded-for": "192.0.2.77", "x-real-ip": "192.0.2.78" }), deps);
    expect(res.headers.get("location")).toBe("/gate?e=locked&m=60");
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("with no Vercel header, spoofed forwarding headers all share one bucket", async () => {
    const { deps } = harness();
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
    const { deps } = harness();
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
      const res = await handleGatePost(post(form(PASS)), harness(env).deps);
      expect(res.headers.get("location")).toBe("/gate?e=closed");
      expect(res.headers.get("set-cookie")).toBeNull();
    }
  });

  // A refusal is a redirect a browser can follow back to the gate, never a bare
  // body, and it must reach neither the hash nor the attempt count.
  async function expectRefused(req: Request) {
    const hashed: string[] = [];
    const { deps, limiter } = harness();
    const res = await handleGatePost(req, { ...deps, verify: (input: string) => (hashed.push(input), true) });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/gate?e=refused");
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(hashed).toEqual([]);
    const after = limiter.check("203.0.113.10");
    expect(after.allowed && after.ipLeft).toBe(5);
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
    const { deps } = harness();
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
    const { deps } = harness();
    const spy = { ...deps, verify: (input: string) => (hashed.push(input), false) };
    expect((await handleGatePost(post("passcode="), spy)).headers.get("location")).toBe("/gate?e=wrong&left=4");
    expect((await handleGatePost(post(form("y".repeat(257))), spy)).headers.get("location")).toBe("/gate?e=wrong&left=3");
    expect(hashed).toEqual([]);
    await handleGatePost(post(form("y".repeat(256))), spy);
    expect(hashed).toHaveLength(1);
  });

  it("never sends the passcode, the hash or the secret back", async () => {
    const { deps } = harness();
    for (const res of [await handleGatePost(post(form(PASS)), deps), await handleGatePost(post(form("nope")), deps)]) {
      const all = `${res.headers.get("location")} ${res.headers.get("set-cookie")} ${await res.text()}`;
      expect(all).not.toContain(PASS);
      expect(all).not.toContain(SECRET);
      expect(all).not.toContain(ENV.CONSOLE_PASSCODE_HASH.split("$")[2]!);
    }
  });
});

describe("hasValidSession", () => {
  it("is false without a secret, a cookie, or a signature from this server", () => {
    expect(hasValidSession(undefined, ENV, T0)).toBe(false);
    expect(hasValidSession("v1.9999999999.abcdefghijklmnop.forged", ENV, T0)).toBe(false);
    expect(hasValidSession("anything", {}, T0)).toBe(false);
  });
});
