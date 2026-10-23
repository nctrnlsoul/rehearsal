import { describe, expect, it } from "vitest";
import { MAX_ROWS, assertSupabaseUrl, createDb, readConfig } from "../lib/db";

const PROJECT = "https://abcdefghijklmnop.supabase.co";
const KEY = "fake-secret-key-do-not-use";
const CONFIG = { url: new URL(PROJECT), key: KEY };

type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };

function fakeFetch(responses: Array<{ status: number; body?: unknown }>) {
  const calls: Call[] = [];
  const impl = (async (input: unknown, init: Record<string, unknown>) => {
    const raw = init["body"];
    calls.push({
      url: String(input),
      method: String(init["method"] ?? "GET"),
      headers: { ...((init["headers"] ?? {}) as Record<string, string>) },
      body: typeof raw === "string" ? JSON.parse(raw) : null,
    });
    const next = responses.shift();
    if (next === undefined) throw new Error("fake fetch ran out of queued responses");
    return new Response(next.body === undefined ? null : JSON.stringify(next.body), {
      status: next.status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe("assertSupabaseUrl", () => {
  it("pins the storage host", () => {
    expect(assertSupabaseUrl(PROJECT).hostname).toBe("abcdefghijklmnop.supabase.co");
    for (const bad of [
      "http://abcdefghijklmnop.supabase.co",
      "https://evil.test",
      "https://evil-supabase.co",
      "https://supabase.co.evil.test",
      "https://u:p@abcdefghijklmnop.supabase.co",
      "nonsense",
    ]) {
      expect(() => assertSupabaseUrl(bad), bad).toThrow();
    }
  });
});

describe("readConfig", () => {
  it("returns null when unconfigured and throws when half configured", () => {
    expect(readConfig({})).toBeNull();
    expect(() => readConfig({ SUPABASE_URL: PROJECT })).toThrow(/SERVICE_ROLE_KEY/);
    expect(() => readConfig({ SUPABASE_SERVICE_ROLE_KEY: KEY })).toThrow(/SUPABASE_URL/);
  });
});

describe("db operations", () => {
  it("sends the key on apikey only, never as a bearer token", async () => {
    const f = fakeFetch([{ status: 201 }]);
    await createDb(CONFIG, { fetchImpl: f.impl }).insert({
      eventId: "WH-1",
      eventType: "PAYMENT.CAPTURE.COMPLETED",
      captureId: "CAP-1",
      amount: "54.00",
      currency: "USD",
      action: "fulfilled",
      verified: true,
    });
    const headers = f.calls[0]!.headers;
    expect(headers["apikey"]).toBe(KEY);
    expect(headers["Authorization"]).toBeUndefined();
    const carrying = Object.entries(headers)
      .filter(([, v]) => typeof v === "string" && v.includes(KEY))
      .map(([k]) => k);
    expect(carrying).toEqual(["apikey"]);
  });

  it("looks an event up by id", async () => {
    const f = fakeFetch([{ status: 200, body: [{ id: 1 }] }]);
    const found = await createDb(CONFIG, { fetchImpl: f.impl }).hasEvent("WH-1");
    expect(found).toBe(true);
    expect(decodeURIComponent(f.calls[0]!.url)).toContain("event_id=eq.WH-1");
  });

  it("reports an absent event as absent", async () => {
    const f = fakeFetch([{ status: 200, body: [] }]);
    expect(await createDb(CONFIG, { fetchImpl: f.impl }).hasEvent("WH-NONE")).toBe(false);
  });

  // The webhook endpoint is publicly writable, so an ascending read plus a cap
  // would let anyone pin the window with junk and hide real rows.
  it("reads newest first, hands back oldest first, and scopes to a window", async () => {
    const mk = (id: string, at: string) => ({
      event_id: id,
      event_type: "PAYMENT.CAPTURE.COMPLETED",
      capture_id: "CAP-1",
      amount: "1.00",
      currency: "USD",
      action: "fulfilled",
      verified: true,
      received_at: at,
    });
    const f = fakeFetch([
      { status: 200, body: [mk("WH-NEW", "2026-10-23T12:00:02Z"), mk("WH-OLD", "2026-10-23T12:00:00Z")] },
    ]);
    const rows = await createDb(CONFIG, { fetchImpl: f.impl }).rows({
      sinceIso: "2026-10-23T11:00:00.000Z",
    });
    expect(f.calls[0]!.url).toContain("order=received_at.desc");
    expect(decodeURIComponent(f.calls[0]!.url)).toContain("received_at=gte.2026-10-23T11:00:00.000Z");
    expect(rows.map((r) => r.eventId)).toEqual(["WH-OLD", "WH-NEW"]);
  });

  it("clamps the row limit", async () => {
    const f = fakeFetch([{ status: 200, body: [] }, { status: 200, body: [] }]);
    const db = createDb(CONFIG, { fetchImpl: f.impl });
    await db.rows({ limit: 99_999 });
    expect(f.calls[0]!.url).toContain(`limit=${MAX_ROWS}`);
    await db.rows({ limit: 0 });
    expect(f.calls[1]!.url).toContain("limit=1");
  });

  it("throws with the status only, never the key", async () => {
    const f = fakeFetch([{ status: 401, body: { message: KEY } }]);
    const db = createDb(CONFIG, { fetchImpl: f.impl });
    await expect(db.rows()).rejects.toThrow(/http 401/);
    const f2 = fakeFetch([{ status: 401, body: { message: KEY } }]);
    await expect(createDb(CONFIG, { fetchImpl: f2.impl }).rows()).rejects.not.toThrow(
      new RegExp(KEY),
    );
  });
});
