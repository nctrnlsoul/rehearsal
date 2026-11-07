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

  // The length rule reads the trimmed value, so the compare must too: a value
  // pasted with a trailing newline otherwise locks out the right caller.
  it("compares against the trimmed token, as the length rule reads it", async () => {
    process.env["REHEARSAL_STORE_TOKEN"] = `  ${TOKEN}\n`;
    expect((await get()).status).not.toBe(401);
    expect((await get("", `Bearer ${TOKEN}x`)).status).toBe(401);
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

// R-044, through the route and the real table: the reply carries each
// delivery's capture ids and receive times, so the console can pair exactly.
describe("store state reply", () => {
  it("gives each delivery its capture ids and receive times from the table, verified rows only", async () => {
    const { freshDb } = await import("./pg");
    const { postgrestOver } = await import("./postgrest");
    const pg = await freshDb();
    await pg.exec(`insert into public.store_order_events (event_id, event_type, capture_id, action, verified, received_at) values
      ('WH-1', 'PAYMENT.CAPTURE.COMPLETED', 'CAP-1', 'fulfilled', true, '2026-10-25T18:00:07.125Z'),
      ('WH-1', 'PAYMENT.CAPTURE.COMPLETED', 'CAP-1', 'duplicate_ignored', true, '2026-10-25T18:00:40.250Z'),
      ('WH-1', 'PAYMENT.CAPTURE.COMPLETED', null, 'refused', false, '2026-10-25T18:00:01.000Z')`);
    process.env["SUPABASE_URL"] = "https://testproject.supabase.co";
    process.env["SUPABASE_SERVICE_ROLE_KEY"] = "test-only-key";
    vi.stubGlobal("fetch", postgrestOver(pg));
    try {
      const res = await get();
      expect(res.status).toBe(200);
      const body = (await res.json()) as { deliveries: Array<Record<string, unknown>> };
      expect(body).toMatchObject({ truncated: false, refusalsTruncated: false });
      expect(body.deliveries).toEqual([
        expect.objectContaining({ eventId: "WH-1", captureIds: ["CAP-1"], receivedAt: ["2026-10-25T18:00:07.125Z", "2026-10-25T18:00:40.250Z"] }),
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
