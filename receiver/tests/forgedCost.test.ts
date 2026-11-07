import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "../app/api/paypal/webhook/route";
import { forgetToken } from "../lib/paypalToken";

/**
 * Audit 2026-10-25 M3: every forged webhook cost PayPal calls. The receiver
 * called PayPal even for a request with no transmission headers, and fetched a
 * new token every time. fetch is stubbed: nothing here reaches PayPal or
 * Supabase.
 */

const ENV = {
  SUPABASE_URL: "https://testproject.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "test-only-key",
  PAYPAL_SELLER_CLIENT_ID: "test-id",
  PAYPAL_SELLER_CLIENT_SECRET: "test-secret",
  REHEARSAL_WEBHOOK_ID: "WH-TEST",
};

let saved: Record<string, string | undefined>;
let paypal: string[];
let rows: Array<Record<string, unknown>>;

beforeEach(() => {
  forgetToken();
  saved = Object.fromEntries(Object.keys(ENV).map((k) => [k, process.env[k]]));
  Object.assign(process.env, ENV);
  paypal = [];
  rows = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("paypal.com")) {
        paypal.push(new URL(url).pathname);
        if (url.endsWith("/v1/oauth2/token")) {
          return Response.json({ access_token: "tok", expires_in: 32400 });
        }
        return Response.json({ verification_status: "FAILURE" });
      }
      rows.push(...(JSON.parse(String(init?.body)) as Array<Record<string, unknown>>));
      return new Response(null, { status: 201 });
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

const ALL = {
  "paypal-transmission-id": "69cd13f0-d67a-11e5-baa3-778b53f4ae55",
  "paypal-transmission-time": new Date().toISOString(),
  "paypal-transmission-sig": "forged",
  "paypal-auth-algo": "SHA256withRSA",
  "paypal-cert-url": "https://api.sandbox.paypal.com/v1/notifications/certs/C",
};

const post = (headers: Record<string, string>) =>
  POST(
    new Request("https://receiver.test/api/paypal/webhook", {
      method: "POST",
      body: JSON.stringify({ id: "WH-FORGED", event_type: "PAYMENT.CAPTURE.COMPLETED" }),
      headers,
    }),
  );

describe("a forged delivery costs no PayPal call unless it carries all five headers", () => {
  it("no headers at all: recorded unverified, no PayPal call", async () => {
    expect((await post({})).status).toBe(200);
    expect(paypal).toEqual([]);
    expect(rows[0]).toMatchObject({ event_id: "WH-FORGED", verified: false });
    expect(String(rows[0]!["verify_detail"])).toMatch(/^missing paypal-transmission-id/);
  });

  it.each(Object.keys(ALL))("only %s missing: no PayPal call, and it is named", async (header) => {
    const headers: Record<string, string> = { ...ALL };
    delete headers[header];
    await post(headers);
    expect(paypal).toEqual([]);
    expect(rows[0]!["verify_detail"]).toBe(`missing ${header}`);
  });

  it("ten forged deliveries with every header make one token call and ten verify calls", async () => {
    for (let i = 0; i < 10; i += 1) await post({ ...ALL, "paypal-transmission-id": `69cd13f0-d67a-11e5-baa3-778b53f4ae${String(i).padStart(2, "0")}` });
    expect(paypal.filter((p) => p === "/v1/oauth2/token")).toHaveLength(1);
    expect(paypal.filter((p) => p === "/v1/notifications/verify-webhook-signature")).toHaveLength(10);
    expect(rows.every((r) => r["verified"] === false)).toBe(true);
  });
});
