import { describe, expect, it } from "vitest";
import {
  INSTANCE_ID,
  MAX_ROWS,
  assertSupabaseUrl,
  createLedger,
  readConfig,
} from "../lib/ledger";

const PROJECT = "https://abcdefghijklmnop.supabase.co";
const KEY = "fake-service-role-key-do-not-use";
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
  it("accepts a project URL", () => {
    expect(assertSupabaseUrl(PROJECT).hostname).toBe("abcdefghijklmnop.supabase.co");
  });

  // The storage host receives every webhook we record, so it is pinned.
  it("refuses anything that is not a supabase.co host over https", () => {
    for (const bad of [
      "http://abcdefghijklmnop.supabase.co",
      "https://evil.test",
      "https://evil-supabase.co",
      "https://supabase.co.evil.test",
      "https://user:pw@abcdefghijklmnop.supabase.co",
      "not a url",
      "",
    ]) {
      expect(() => assertSupabaseUrl(bad), JSON.stringify(bad)).toThrow();
    }
  });

  it("does not put userinfo into the thrown message", () => {
    let message = "";
    try {
      assertSupabaseUrl("https://svc:sUp3rS3cr3t@evil.test");
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).not.toContain("sUp3rS3cr3t");
  });
});

describe("readConfig", () => {
  it("returns null when storage is simply not configured", () => {
    expect(readConfig({})).toBeNull();
    expect(readConfig({ SUPABASE_URL: "  ", SUPABASE_SERVICE_ROLE_KEY: "" })).toBeNull();
  });

  // Half-configured is a mistake, not a decision to run without storage.
  it("throws when only one of the two is set", () => {
    expect(() => readConfig({ SUPABASE_URL: PROJECT })).toThrow(/SERVICE_ROLE_KEY is not/);
    expect(() => readConfig({ SUPABASE_SERVICE_ROLE_KEY: KEY })).toThrow(/SUPABASE_URL is not/);
  });

  it("returns a config when both are present, trimming whitespace", () => {
    const c = readConfig({ SUPABASE_URL: ` ${PROJECT} `, SUPABASE_SERVICE_ROLE_KEY: ` ${KEY} ` });
    expect(c).not.toBeNull();
    expect(c!.url.origin).toBe(PROJECT);
    expect(c!.key).toBe(KEY);
  });

  it("throws on a configured but unusable host", () => {
    expect(() =>
      readConfig({ SUPABASE_URL: "https://evil.test", SUPABASE_SERVICE_ROLE_KEY: KEY }),
    ).toThrow(/not a supabase\.co host/);
  });
});

describe("ledger append", () => {
  const row = {
    eventId: "WH-1",
    eventType: "PAYMENT.CAPTURE.COMPLETED",
    receivedAtMs: Date.parse("2026-10-23T12:00:00.000Z"),
    verified: true,
    verifyDetail: "SUCCESS",
    resourceId: "CAP-1",
    transmissionId: "TX-1",
  };

  it("inserts into the right table with both auth headers", async () => {
    const f = fakeFetch([{ status: 201 }]);
    await createLedger(CONFIG, { fetchImpl: f.impl }).append(row);
    const call = f.calls[0]!;
    expect(call.method).toBe("POST");
    expect(call.url).toBe(`${PROJECT}/rest/v1/webhook_arrivals`);
    expect(call.headers["apikey"]).toBe(KEY);
    expect(call.headers["Authorization"]).toBe(`Bearer ${KEY}`);
    expect(call.headers["Prefer"]).toBe("return=minimal");
  });

  it("maps every column and stamps the writing instance", async () => {
    const f = fakeFetch([{ status: 201 }]);
    await createLedger(CONFIG, { fetchImpl: f.impl }).append(row);
    expect(f.calls[0]!.body).toEqual([
      {
        event_id: "WH-1",
        event_type: "PAYMENT.CAPTURE.COMPLETED",
        received_at: "2026-10-23T12:00:00.000Z",
        verified: true,
        verify_detail: "SUCCESS",
        resource_id: "CAP-1",
        transmission_id: "TX-1",
        instance_id: INSTANCE_ID,
      },
    ]);
  });

  it("carries a null event id through rather than dropping the arrival", async () => {
    const f = fakeFetch([{ status: 201 }]);
    await createLedger(CONFIG, { fetchImpl: f.impl }).append({
      ...row,
      eventId: null,
      verified: null,
    });
    const sent = (f.calls[0]!.body as Array<Record<string, unknown>>)[0]!;
    expect(sent["event_id"]).toBeNull();
    expect(sent["verified"]).toBeNull();
  });

  it("throws on a non-2xx and never puts the key in the message", async () => {
    const f = fakeFetch([{ status: 401, body: { message: KEY } }]);
    const ledger = createLedger(CONFIG, { fetchImpl: f.impl });
    await expect(ledger.append(row)).rejects.toThrow(/http 401/);
    await expect(ledger.append(row)).rejects.not.toThrow(new RegExp(KEY));
  });
});

describe("ledger snapshot", () => {
  const dbRow = {
    event_id: "WH-1",
    event_type: "PAYMENT.CAPTURE.COMPLETED",
    received_at: "2026-10-23T12:00:00.000Z",
    verified: false,
    verify_detail: "FAILURE",
    resource_id: "CAP-1",
    transmission_id: "TX-1",
    instance_id: "inst-a",
  };

  // The cap has to bite the NEWEST end. Ascending plus a limit returns the
  // oldest rows, so once the table passes the cap every new arrival is
  // invisible, and the webhook endpoint is publicly writable by necessity.
  it("reads newest-first so the row cap cannot hide recent arrivals", async () => {
    const f = fakeFetch([{ status: 200, body: [] }]);
    await createLedger(CONFIG, { fetchImpl: f.impl }).snapshot();
    expect(f.calls[0]!.url).toContain("order=received_at.desc");
    expect(f.calls[0]!.url).not.toContain("received_at.asc");
  });

  it("hands rows back oldest-first despite reading newest-first", async () => {
    const newest = { ...dbRow, event_id: "WH-NEW", received_at: "2026-10-23T12:00:02.000Z" };
    const middle = { ...dbRow, event_id: "WH-MID", received_at: "2026-10-23T12:00:01.000Z" };
    const oldest = { ...dbRow, event_id: "WH-OLD", received_at: "2026-10-23T12:00:00.000Z" };
    // PostgREST returns descending; callers still expect arrival order.
    const f = fakeFetch([{ status: 200, body: [newest, middle, oldest] }]);
    const rows = await createLedger(CONFIG, { fetchImpl: f.impl }).snapshot();
    expect(rows.map((r) => r.eventId)).toEqual(["WH-OLD", "WH-MID", "WH-NEW"]);
    expect(rows[0]!.receivedAtMs).toBeLessThan(rows[2]!.receivedAtMs);
  });

  it("scopes to a window when asked, so a backlog cannot crowd a run out", async () => {
    const f = fakeFetch([{ status: 200, body: [] }, { status: 200, body: [] }]);
    const ledger = createLedger(CONFIG, { fetchImpl: f.impl });
    await ledger.snapshot({ sinceIso: "2026-10-23T11:59:00.000Z" });
    expect(decodeURIComponent(f.calls[0]!.url)).toContain("received_at=gte.2026-10-23T11:59:00.000Z");
    await ledger.snapshot();
    expect(f.calls[1]!.url).not.toContain("received_at=gte");
  });

  it("maps to the wire shape the gate expects", async () => {
    const f = fakeFetch([{ status: 200, body: [dbRow] }]);
    const rows = await createLedger(CONFIG, { fetchImpl: f.impl }).snapshot();
    expect(rows).toEqual([
      {
        eventId: "WH-1",
        eventType: "PAYMENT.CAPTURE.COMPLETED",
        receivedAtMs: Date.parse("2026-10-23T12:00:00.000Z"),
        verified: false,
        verifyDetail: "FAILURE",
        resourceId: "CAP-1",
        transmissionId: "TX-1",
        instanceId: "inst-a",
      },
    ]);
  });

  it("keeps an unattempted verification as null, not false", async () => {
    const f = fakeFetch([{ status: 200, body: [{ ...dbRow, verified: null }] }]);
    const rows = await createLedger(CONFIG, { fetchImpl: f.impl }).snapshot();
    expect(rows[0]!.verified).toBeNull();
  });

  it("survives a row with missing columns", async () => {
    const f = fakeFetch([{ status: 200, body: [{}] }]);
    const rows = await createLedger(CONFIG, { fetchImpl: f.impl }).snapshot();
    expect(rows[0]!.eventId).toBeNull();
    expect(rows[0]!.instanceId).toBe("unknown");
    expect(rows[0]!.receivedAtMs).toBe(0);
  });

  it("clamps the limit", async () => {
    const f = fakeFetch([{ status: 200, body: [] }, { status: 200, body: [] }]);
    const ledger = createLedger(CONFIG, { fetchImpl: f.impl });
    await ledger.snapshot({ limit: 99_999 });
    expect(f.calls[0]!.url).toContain(`limit=${MAX_ROWS}`);
    await ledger.snapshot({ limit: 0 });
    expect(f.calls[1]!.url).toContain("limit=1");
  });

  it("throws on a non-2xx and on a body that is not a row array", async () => {
    const bad = fakeFetch([{ status: 500 }]);
    await expect(createLedger(CONFIG, { fetchImpl: bad.impl }).snapshot()).rejects.toThrow(
      /http 500/,
    );
    const wrong = fakeFetch([{ status: 200, body: { oops: true } }]);
    await expect(createLedger(CONFIG, { fetchImpl: wrong.impl }).snapshot()).rejects.toThrow(
      /row array/,
    );
  });
});
