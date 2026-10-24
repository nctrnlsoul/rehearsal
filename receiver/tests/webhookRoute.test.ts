import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "../app/api/paypal/webhook/route";

/**
 * Route-level test that the cert URL check is actually wired in: a bad cert URL
 * is recorded as unverified and never forwarded to PayPal. fetch is stubbed, so
 * nothing here reaches Supabase or PayPal.
 */

const ENV = {
  SUPABASE_URL: "https://testproject.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "test-only-key",
  PAYPAL_SELLER_CLIENT_ID: "test-id",
  PAYPAL_SELLER_CLIENT_SECRET: "test-secret",
  REHEARSAL_WEBHOOK_ID: "WH-TEST",
};

let saved: Record<string, string | undefined>;
let rows: Array<Record<string, unknown>>;
let paypalCalls: string[];

beforeEach(() => {
  saved = Object.fromEntries(Object.keys(ENV).map((k) => [k, process.env[k]]));
  Object.assign(process.env, ENV);
  rows = [];
  paypalCalls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("paypal.com")) {
        paypalCalls.push(url);
        return new Response("{}", { status: 500 });
      }
      if (url.includes("/rest/v1/webhook_arrivals") && init?.method === "POST") {
        const body: unknown = JSON.parse(String(init.body));
        rows.push(...(Array.isArray(body) ? body : [body]));
        return new Response(null, { status: 201 });
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

const headers = (certUrl: string) => ({
  "paypal-transmission-id": "T-1",
  "paypal-transmission-time": "2026-10-23T00:00:00Z",
  "paypal-transmission-sig": "sig",
  "paypal-auth-algo": "SHA256withRSA",
  "paypal-cert-url": certUrl,
});

const post = (certUrl: string) =>
  POST(
    new Request("https://receiver.test/api/paypal/webhook", {
      method: "POST",
      body: JSON.stringify({ id: "WH-1", event_type: "PAYMENT.CAPTURE.COMPLETED" }),
      headers: headers(certUrl),
    }),
  );

describe("the receiver refuses a bad cert URL before any PayPal call", () => {
  it.each([
    ["http://api.sandbox.paypal.com/c", "paypal-cert-url is not https"],
    ["https://www.paypal.com/c", "paypal-cert-url host www.paypal.com is not a PayPal API host"],
  ])("%s", async (certUrl, detail) => {
    const res = await post(certUrl);
    expect(res.status).toBe(200);
    expect(paypalCalls).toEqual([]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ verified: false, verify_detail: detail });
  });

  it("forwards a good cert URL to PayPal", async () => {
    await post("https://api.sandbox.paypal.com/v1/notifications/certs/C");
    expect(paypalCalls.length).toBeGreaterThan(0);
  });
});

describe("the receiver bounds what it will read", () => {
  it("refuses an oversized body with 413, records nothing and calls nobody", async () => {
    const res = await POST(
      new Request("https://receiver.test/api/paypal/webhook", {
        method: "POST",
        body: "x".repeat(1_000_001),
        headers: headers("https://api.sandbox.paypal.com/c"),
      }),
    );
    expect(res.status).toBe(413);
    expect(rows).toEqual([]);
    expect(paypalCalls).toEqual([]);
  });
});
