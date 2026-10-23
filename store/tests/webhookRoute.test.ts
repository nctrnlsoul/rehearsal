import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "../app/api/paypal/webhook/route";

/**
 * Route-level tests for refusals. Every refused request must leave a row with
 * a reason, so a refused delivery is never mistaken for one that did not
 * arrive, and the refusal must stand whether or not that row could be written.
 * fetch is stubbed: nothing here reaches Supabase or PayPal.
 */

const URL_BASE = "https://store.test/api/paypal/webhook";
const ENV = {
  SUPABASE_URL: "https://testproject.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "test-only-key",
  PAYPAL_SELLER_CLIENT_ID: "test-id",
  PAYPAL_SELLER_CLIENT_SECRET: "test-secret",
};

let saved: Record<string, string | undefined>;
let inserts: Array<Record<string, unknown>>;
let paypalCalls: string[];
let insertStatus: number;

beforeEach(() => {
  saved = Object.fromEntries(Object.keys(ENV).map((k) => [k, process.env[k]]));
  Object.assign(process.env, ENV);
  inserts = [];
  paypalCalls = [];
  insertStatus = 201;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("paypal.com")) {
        paypalCalls.push(url);
        return new Response("{}", { status: 500 });
      }
      if (url.includes("/rest/v1/store_order_events") && init?.method === "POST") {
        inserts.push(...(JSON.parse(String(init.body)) as Array<Record<string, unknown>>));
        return new Response(null, { status: insertStatus });
      }
      return new Response("[]", { status: 200 });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const capture = { id: "WH-1", event_type: "PAYMENT.CAPTURE.COMPLETED", resource: { id: "CAP-1" } };
const post = (body: string, headers: Record<string, string> = {}) =>
  POST(new Request(URL_BASE, { method: "POST", body, headers }));
const signedLooking = (over: Record<string, string> = {}) => ({
  "paypal-transmission-id": "T-1",
  "paypal-transmission-time": "2026-10-23T00:00:00Z",
  "paypal-transmission-sig": "sig",
  "paypal-auth-algo": "SHA256withRSA",
  "paypal-cert-url": "https://api.sandbox.paypal.com/v1/notifications/certs/C",
  ...over,
});

describe("every refusal leaves a row with its reason", () => {
  it("an unsigned event: 401, refused, names the missing headers, no PayPal call", async () => {
    const res = await post(JSON.stringify(capture));
    expect(res.status).toBe(401);
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toMatchObject({ event_id: "WH-1", action: "refused", verified: false });
    expect(String(inserts[0]!["reason"])).toMatch(/^missing paypal-transmission-id/);
    expect(paypalCalls).toEqual([]);
  });

  it("a non-PayPal cert host: 401, refused, names the host, no PayPal call", async () => {
    const res = await post(
      JSON.stringify(capture),
      signedLooking({ "paypal-cert-url": "https://certs.evil.test/c" }),
    );
    expect(res.status).toBe(401);
    expect(inserts[0]).toMatchObject({ action: "refused", verified: false });
    expect(inserts[0]!["reason"]).toBe("paypal-cert-url host certs.evil.test is not paypal.com");
    // What the refused request claimed is kept, for comparison with real deliveries.
    expect(inserts[0]!["cert_host"]).toBe("certs.evil.test");
    expect(paypalCalls).toEqual([]);
  });

  it("records no cert host when the request sent none", async () => {
    await post(JSON.stringify(capture));
    expect(inserts[0]!["cert_host"]).toBeNull();
  });

  it("a body that is not JSON: 400, refused with no event id, cert host kept", async () => {
    const res = await post("{ not json", signedLooking());
    expect(res.status).toBe(400);
    expect(inserts).toEqual([
      {
        event_id: null,
        event_type: "UNKNOWN",
        capture_id: null,
        amount: null,
        currency: null,
        action: "refused",
        verified: null,
        reason: "body is not JSON",
        cert_host: "api.sandbox.paypal.com",
      },
    ]);
  });

  it("an oversized body: 413, refused", async () => {
    const res = await post("x".repeat(1_000_001));
    expect(res.status).toBe(413);
    expect(inserts[0]).toMatchObject({ action: "refused", reason: "body over 1000000 characters" });
  });

  // Recording is evidence, never a way in: a failed write must not turn a
  // refusal into an acceptance.
  it("still refuses when the refusal row cannot be written", async () => {
    insertStatus = 500;
    expect((await post("{ not json")).status).toBe(400);
    expect((await post("x".repeat(1_000_001))).status).toBe(413);
    const unsigned = await post(JSON.stringify(capture));
    expect(unsigned.status).toBeGreaterThanOrEqual(400);
  });

  it("never records a refused event as fulfilled", async () => {
    await post(JSON.stringify(capture));
    await post(JSON.stringify(capture), signedLooking({ "paypal-cert-url": "not a url" }));
    expect(inserts.map((r) => r["action"])).toEqual(["refused", "refused"]);
  });
});
