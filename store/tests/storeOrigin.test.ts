import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "../app/api/paypal/webhook/route";
import { forgetToken } from "../lib/paypalToken";
import { STORE_WEBHOOK_PATH, storeOrigin } from "../lib/verify";

/**
 * Audit 2026-10-25 L4: the store built its own handler URL from the request's
 * Host, which the sender chooses. It now comes from env only. fetch is
 * stubbed: nothing here reaches PayPal or Supabase.
 */

const ENV = {
  SUPABASE_URL: "https://testproject.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "test-only-key",
  PAYPAL_SELLER_CLIENT_ID: "test-id",
  PAYPAL_SELLER_CLIENT_SECRET: "test-secret",
  REHEARSAL_STORE_ORIGIN: "https://store-pinned.test",
  REHEARSAL_STORE_WEBHOOK_ID: undefined as string | undefined,
};

let saved: Record<string, string | undefined>;
let paypal: string[];
let verifiedAgainst: unknown[];

beforeEach(() => {
  forgetToken();
  saved = Object.fromEntries(Object.keys(ENV).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(ENV)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  paypal = [];
  verifiedAgainst = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("paypal.com")) {
        paypal.push(new URL(url).pathname);
        if (url.endsWith("/v1/oauth2/token")) return Response.json({ access_token: "tok", expires_in: 32400 });
        if (url.endsWith("/v1/notifications/webhooks")) {
          return Response.json({
            webhooks: [
              { id: "WH-PINNED", url: `https://store-pinned.test${STORE_WEBHOOK_PATH}` },
              { id: "WH-ALIAS", url: `https://alias.test${STORE_WEBHOOK_PATH}` },
            ],
          });
        }
        verifiedAgainst.push((JSON.parse(String(init?.body)) as { webhook_id: unknown }).webhook_id);
        return Response.json({ verification_status: "SUCCESS" });
      }
      if (url.includes("/rpc/store_record_event")) return Response.json("fulfilled");
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

const signed = {
  "paypal-transmission-id": "69cd13f0-d67a-11e5-baa3-778b53f4ae55",
  "paypal-transmission-time": new Date().toISOString(),
  "paypal-transmission-sig": "sig",
  "paypal-auth-algo": "SHA256withRSA",
  "paypal-cert-url": "https://api.sandbox.paypal.com/v1/notifications/certs/C",
};
const postTo = (host: string) =>
  POST(
    new Request(`https://${host}${STORE_WEBHOOK_PATH}`, {
      method: "POST",
      body: JSON.stringify({ id: "WH-1", event_type: "PAYMENT.CAPTURE.COMPLETED", resource: { id: "CAP-1" } }),
      headers: signed,
    }),
  );

describe("the store names its webhook from env, never from the request's Host (L4)", () => {
  it("verifies against the env origin's webhook whatever Host the request names", async () => {
    expect((await postTo("alias.test")).status).toBe(200);
    expect((await postTo("anything-else.test")).status).toBe(200);
    expect(verifiedAgainst).toEqual(["WH-PINNED", "WH-PINNED"]);
  });

  it("a pinned webhook id needs no lookup and no origin", async () => {
    process.env["REHEARSAL_STORE_WEBHOOK_ID"] = "WH-ENV";
    delete process.env["REHEARSAL_STORE_ORIGIN"];
    expect((await postTo("alias.test")).status).toBe(200);
    expect(verifiedAgainst).toEqual(["WH-ENV"]);
    expect(paypal).not.toContain("/v1/notifications/webhooks");
  });

  it("with neither set, refuses with 503 and makes no PayPal call", async () => {
    delete process.env["REHEARSAL_STORE_ORIGIN"];
    expect((await postTo("store-pinned.test")).status).toBe(503);
    expect(paypal).toEqual([]);
  });
});

describe("storeOrigin", () => {
  it("accepts an https origin, with or without a trailing slash", () => {
    expect(storeOrigin({ REHEARSAL_STORE_ORIGIN: "https://store.test" })).toEqual({ origin: "https://store.test" });
    expect(storeOrigin({ REHEARSAL_STORE_ORIGIN: " https://store.test/ " })).toEqual({ origin: "https://store.test" });
    expect(storeOrigin({ REHEARSAL_STORE_ORIGIN: "http://localhost:3001" })).toEqual({ origin: "http://localhost:3001" });
  });

  it("normalizes the default port and the host's case, as the URL standard does", () => {
    expect(storeOrigin({ REHEARSAL_STORE_ORIGIN: "https://Store.Test:443" })).toEqual({ origin: "https://store.test" });
  });

  it.each([
    ["", /neither/],
    ["store.test", /not a URL/],
    ["http://store.test", /not https/],
    ["https://store.test/api/paypal/webhook", /origin only/],
    ["https://store.test?x=1", /origin only/],
    ["https://user:pw@store.test", /origin only/],
    ["https://store.test/#x", /origin only/],
    ["https://store.test?", /origin only/],
  ])("refuses %j", (raw, detail) => {
    const out = storeOrigin({ REHEARSAL_STORE_ORIGIN: raw });
    expect(out.origin).toBeNull();
    expect(out).toMatchObject({ detail: expect.stringMatching(detail) });
  });
});
