import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "../app/api/store/state/route";

/**
 * Route-level tests for the state endpoint's gates. The handler is a plain
 * function over a Request, so this needs no server and no Supabase project.
 */

const TOKEN = "test-only-store-token-32-characters-long";
const BASE = "https://store.test/api/store/state";

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {
    REHEARSAL_STORE_TOKEN: process.env["REHEARSAL_STORE_TOKEN"],
    SUPABASE_URL: process.env["SUPABASE_URL"],
    SUPABASE_SERVICE_ROLE_KEY: process.env["SUPABASE_SERVICE_ROLE_KEY"],
  };
  process.env["REHEARSAL_STORE_TOKEN"] = TOKEN;
  // Unconfigured storage, so nothing here can reach a network.
  delete process.env["SUPABASE_URL"];
  delete process.env["SUPABASE_SERVICE_ROLE_KEY"];
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const get = (query = "", auth: string | null = `Bearer ${TOKEN}`) =>
  GET(new Request(`${BASE}${query}`, { headers: auth === null ? {} : { authorization: auth } }));

describe("store state endpoint gates", () => {
  it("demands a bearer token", async () => {
    expect((await get("", null)).status).toBe(401);
    expect((await get("", "Bearer wrong")).status).toBe(401);
    expect((await get("", "Basic something")).status).toBe(401);
  });

  it("locks itself when no token is configured, rather than opening", async () => {
    delete process.env["REHEARSAL_STORE_TOKEN"];
    expect((await get()).status).toBe(503);
  });

  // A blank variable is a misconfiguration, not a password of spaces.
  it("locks itself when the token is blank, even for a caller who sends that blank", async () => {
    process.env["REHEARSAL_STORE_TOKEN"] = "   ";
    for (const res of [await get("", "Bearer    "), await get()]) {
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: "store not configured" });
    }
  });

  // L5 (audit 2026-10-25): a short shared secret is guessable, so it is a misconfiguration.
  it("locks itself when the token is under 32 characters, even for a caller who sends it", async () => {
    const short = "s".repeat(31);
    process.env["REHEARSAL_STORE_TOKEN"] = short;
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await get("", `Bearer ${short}`);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "store not configured" });
  });

  it("accepts a token of exactly 32 characters", async () => {
    const exact = "e".repeat(32);
    process.env["REHEARSAL_STORE_TOKEN"] = exact;
    const res = await get("", `Bearer ${exact}`);
    expect(await res.json()).not.toEqual({ error: "store not configured" });
  });

  it("checks auth before the query, so an anonymous caller learns nothing", async () => {
    expect((await get("?since=nonsense", null)).status).toBe(401);
  });

  // Validated at the trust boundary: answers 400 whatever the storage is doing.
  it("rejects an unparseable since even with no storage configured", async () => {
    const res = await get("?since=nonsense");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "since must be an ISO timestamp" });
  });

  it("reports storage unavailable only once the request is valid", async () => {
    expect((await get("?since=2026-10-23T00:00:00Z")).status).toBe(503);
    expect((await get()).status).toBe(503);
  });

  it("refuses a half-configured store rather than reading without it", async () => {
    process.env["SUPABASE_SERVICE_ROLE_KEY"] = "not-a-real-key";
    expect((await get()).status).toBe(503);
  });
});
