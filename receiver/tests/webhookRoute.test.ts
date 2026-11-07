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
  "paypal-transmission-id": "69cd13f0-d67a-11e5-baa3-778b53f4ae55",
  "paypal-transmission-time": new Date().toISOString(),
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

  // The stub answers PayPal with a 500: an outage, not a forgery.
  it("records a PayPal outage as unchecked, never as a failed signature", async () => {
    await post("https://api.sandbox.paypal.com/v1/notifications/certs/C");
    expect(rows).toHaveLength(1);
    expect(rows[0]!["verified"]).toBeNull();
  });

  it("records an outage on the verify call itself as unchecked, and forwards the raw body", async () => {
    const verifyBodies: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/v1/oauth2/token")) {
          return new Response(JSON.stringify({ access_token: "tok", expires_in: 32400 }), { status: 200 });
        }
        if (url.endsWith("/v1/notifications/verify-webhook-signature")) {
          verifyBodies.push(String(init?.body));
          return new Response("{}", { status: 503 });
        }
        if (url.includes("/rest/v1/webhook_arrivals") && init?.method === "POST") {
          rows.push(...(JSON.parse(String(init.body)) as Array<Record<string, unknown>>));
          return new Response(null, { status: 201 });
        }
        return new Response("[]", { status: 200 });
      }),
    );
    const raw = '{"id":"WH-2","amount":1.50}';
    await POST(
      new Request("https://receiver.test/api/paypal/webhook", {
        method: "POST",
        body: raw,
        headers: headers("https://api.sandbox.paypal.com/v1/notifications/certs/C"),
      }),
    );
    expect(verifyBodies).toHaveLength(1);
    expect(verifyBodies[0]!.endsWith(`"webhook_event":${raw}}`)).toBe(true);
    expect(rows[0]).toMatchObject({ verified: null, verify_detail: "could not check: verify http 503" });
  });

  it("records a stale transmission time as unchecked, before any PayPal call", async () => {
    await POST(
      new Request("https://receiver.test/api/paypal/webhook", {
        method: "POST",
        body: "{}",
        headers: {
          ...headers("https://api.sandbox.paypal.com/v1/notifications/certs/C"),
          "paypal-transmission-time": new Date(Date.now() - 11 * 60_000).toISOString(),
        },
      }),
    );
    expect(paypalCalls).toEqual([]);
    expect(rows[0]).toMatchObject({ verified: null, verify_detail: "could not check: paypal-transmission-time is more than 10 minutes from now" });
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

// The audit's probe (H1, 2026-10-25): one unauthenticated POST, just under the
// body cap, stored about 990 KB in the ledger.
describe("the receiver bounds what it stores", () => {
  it("an unsigned near-cap event stores a row of a few hundred bytes", async () => {
    const pad = "A".repeat(300_000);
    const body = JSON.stringify({ id: pad, event_type: pad, resource: { id: pad } });
    expect(body.length).toBeGreaterThan(900_000);
    expect(body.length).toBeLessThan(1_000_000);
    const res = await POST(
      new Request("https://receiver.test/api/paypal/webhook", {
        method: "POST",
        body,
        headers: { ...headers(`https://${"h".repeat(240)}.test/c`), "paypal-transmission-id": pad },
      }),
    );
    expect(res.status).toBe(200);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ event_id: null, event_type: null, resource_id: null, transmission_id: null });
    expect(String(rows[0]!["verify_detail"]).length).toBeLessThanOrEqual(300);
    expect(JSON.stringify(rows[0]).length).toBeLessThan(700);
    expect(paypalCalls).toEqual([]);
  });

  it("keeps ids of up to 128 characters", async () => {
    const id = "W".repeat(128);
    await POST(
      new Request("https://receiver.test/api/paypal/webhook", {
        method: "POST",
        body: JSON.stringify({ id, event_type: "PAYMENT.CAPTURE.COMPLETED", resource: { id: "CAP-1" } }),
        headers: headers("https://www.paypal.com/c"),
      }),
    );
    expect(rows[0]).toMatchObject({ event_id: id, event_type: "PAYMENT.CAPTURE.COMPLETED", resource_id: "CAP-1" });
  });
});

describe("the body cap is in bytes (L6)", () => {
  it("refuses multibyte text over a megabyte with 413, records nothing and calls nobody", async () => {
    const body = JSON.stringify({ id: "WH-1", note: "é".repeat(600_000) });
    expect(body.length).toBeLessThan(1_000_000);
    const res = await POST(
      new Request("https://receiver.test/api/paypal/webhook", {
        method: "POST",
        body,
        headers: headers("https://api.sandbox.paypal.com/c"),
      }),
    );
    expect(res.status).toBe(413);
    expect(rows).toEqual([]);
    expect(paypalCalls).toEqual([]);
  });
});

// The PayPal host is pinned; a followed redirect would carry the bearer token
// or the Basic credentials somewhere nobody pinned.
describe("every PayPal request the receiver makes", () => {
  it("refuses redirects", async () => {
    const seen: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("paypal.com")) {
          seen.push(init?.redirect);
          if (url.endsWith("/v1/oauth2/token")) {
            return new Response(JSON.stringify({ access_token: "tok", expires_in: 32400 }), { status: 200 });
          }
          return Response.json({ verification_status: "SUCCESS" });
        }
        return new Response(null, { status: 201 });
      }),
    );
    await post("https://api.sandbox.paypal.com/v1/notifications/certs/C");
    expect(seen.length).toBeGreaterThan(0);
    for (const r of seen) expect(r).toBe("error");
  });
});
