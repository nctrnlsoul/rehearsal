import { describe, expect, it } from "vitest";
import { STORE_WEBHOOK_PATH, resolveWebhookId, verifySignature } from "../lib/verify";

const CREDS = { PAYPAL_SELLER_CLIENT_ID: "id", PAYPAL_SELLER_CLIENT_SECRET: "secret" };

// The id cache is keyed by URL, so each test uses its own origin and none can
// see another's cached answer.
let n = 0;
const freshOrigin = () => `https://store-${(n += 1)}.test`;

/** Answers the token call and the webhook list; counts verify calls. */
function fakePaypal(webhooks: unknown, opts: { listStatus?: number } = {}) {
  const calls: string[] = [];
  const verifyBodies: unknown[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith("/v1/oauth2/token")) {
      return new Response(JSON.stringify({ access_token: "tok" }), { status: 200 });
    }
    if (url.endsWith("/v1/notifications/webhooks")) {
      return new Response(JSON.stringify({ webhooks }), { status: opts.listStatus ?? 200 });
    }
    if (url.endsWith("/v1/notifications/verify-webhook-signature")) {
      verifyBodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ verification_status: "SUCCESS" }), { status: 200 });
    }
    return new Response("unexpected", { status: 500 });
  }) as typeof fetch;
  return { fetchImpl, calls, verifyBodies };
}

describe("resolveWebhookId matches the store's handler URL exactly", () => {
  it("picks the one webhook whose URL is origin + handler path", async () => {
    const origin = freshOrigin();
    const { fetchImpl } = fakePaypal([
      { id: "WH-OTHER", url: "https://receiver.test/api/paypal/webhook" },
      { id: "WH-STORE", url: `${origin}${STORE_WEBHOOK_PATH}` },
    ]);
    expect(await resolveWebhookId(CREDS, origin, fetchImpl)).toEqual({ id: "WH-STORE" });
  });

  it("ignores a webhook at the bare origin, even when it is listed first", async () => {
    const origin = freshOrigin();
    const { fetchImpl } = fakePaypal([
      { id: "WH-BARE", url: origin },
      { id: "WH-STORE", url: `${origin}${STORE_WEBHOOK_PATH}` },
    ]);
    expect(await resolveWebhookId(CREDS, origin, fetchImpl)).toEqual({ id: "WH-STORE" });
  });

  it("refuses when only prefix matches exist", async () => {
    const origin = freshOrigin();
    const { fetchImpl } = fakePaypal([
      { id: "WH-BARE", url: origin },
      { id: "WH-SLASH", url: `${origin}/` },
      { id: "WH-TRAIL", url: `${origin}${STORE_WEBHOOK_PATH}/` },
      { id: "WH-QUERY", url: `${origin}${STORE_WEBHOOK_PATH}?x=1` },
      { id: "WH-LONGER", url: `${origin}${STORE_WEBHOOK_PATH}-v2` },
    ]);
    const out = await resolveWebhookId(CREDS, origin, fetchImpl);
    expect(out.id).toBeNull();
    expect(out).toMatchObject({ detail: expect.stringContaining("no webhook") });
  });

  it("refuses when an origin is a prefix of another host", async () => {
    const origin = freshOrigin();
    const { fetchImpl } = fakePaypal([
      { id: "WH-EVIL", url: `${origin}.evil.test${STORE_WEBHOOK_PATH}` },
    ]);
    expect((await resolveWebhookId(CREDS, origin, fetchImpl)).id).toBeNull();
  });

  it("fails closed when more than one webhook has the exact URL", async () => {
    const origin = freshOrigin();
    const url = `${origin}${STORE_WEBHOOK_PATH}`;
    const { fetchImpl } = fakePaypal([
      { id: "WH-A", url },
      { id: "WH-B", url },
    ]);
    const out = await resolveWebhookId(CREDS, origin, fetchImpl);
    expect(out.id).toBeNull();
    expect(out).toMatchObject({ detail: expect.stringContaining("2 webhooks") });
  });

  it("fails closed when the webhook list cannot be read", async () => {
    const origin = freshOrigin();
    const { fetchImpl } = fakePaypal([], { listStatus: 500 });
    expect((await resolveWebhookId(CREDS, origin, fetchImpl)).id).toBeNull();
  });

  it("fails closed on a list that is not an array", async () => {
    const origin = freshOrigin();
    const { fetchImpl } = fakePaypal({ url: `${origin}${STORE_WEBHOOK_PATH}`, id: "WH-X" });
    expect((await resolveWebhookId(CREDS, origin, fetchImpl)).id).toBeNull();
  });

  it("caches a resolved id per URL, so a second origin is resolved on its own", async () => {
    const a = freshOrigin();
    const b = freshOrigin();
    const first = fakePaypal([
      { id: "WH-A", url: `${a}${STORE_WEBHOOK_PATH}` },
      { id: "WH-B", url: `${b}${STORE_WEBHOOK_PATH}` },
    ]);
    expect(await resolveWebhookId(CREDS, a, first.fetchImpl)).toEqual({ id: "WH-A" });

    const again = fakePaypal([]);
    expect(await resolveWebhookId(CREDS, a, again.fetchImpl)).toEqual({ id: "WH-A" });
    expect(again.calls).toHaveLength(0);

    expect(await resolveWebhookId(CREDS, b, first.fetchImpl)).toEqual({ id: "WH-B" });
  });

  it("does not cache a refusal, so a later registration is picked up", async () => {
    const origin = freshOrigin();
    expect((await resolveWebhookId(CREDS, origin, fakePaypal([]).fetchImpl)).id).toBeNull();
    const later = fakePaypal([{ id: "WH-NEW", url: `${origin}${STORE_WEBHOOK_PATH}` }]);
    expect(await resolveWebhookId(CREDS, origin, later.fetchImpl)).toEqual({ id: "WH-NEW" });
  });
});

describe("verifySignature does not act when the webhook id is ambiguous", () => {
  const signedHeaders = () =>
    new Headers({
      "paypal-cert-url": "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-1",
      "paypal-auth-algo": "SHA256withRSA",
      "paypal-transmission-id": "T-1",
      "paypal-transmission-sig": "sig",
      "paypal-transmission-time": "2026-10-23T00:00:00Z",
    });

  it("returns verified null, and never asks PayPal to verify, when only a bare-origin webhook exists", async () => {
    const origin = freshOrigin();
    const { fetchImpl, calls } = fakePaypal([{ id: "WH-BARE", url: origin }]);
    const out = await verifySignature(signedHeaders(), { id: "E-1" }, CREDS, origin, fetchImpl);
    expect(out.verified).toBeNull();
    expect(calls.some((c) => c.endsWith("/verify-webhook-signature"))).toBe(false);
  });

  it("returns verified null when two webhooks share the exact URL", async () => {
    const origin = freshOrigin();
    const url = `${origin}${STORE_WEBHOOK_PATH}`;
    const { fetchImpl, calls } = fakePaypal([
      { id: "WH-A", url },
      { id: "WH-B", url },
    ]);
    const out = await verifySignature(signedHeaders(), { id: "E-1" }, CREDS, origin, fetchImpl);
    expect(out.verified).toBeNull();
    expect(out.detail).toContain("2 webhooks");
    expect(calls.some((c) => c.endsWith("/verify-webhook-signature"))).toBe(false);
  });

  it("verifies against the exact-match webhook", async () => {
    const origin = freshOrigin();
    const { fetchImpl, verifyBodies } = fakePaypal([
      { id: "WH-BARE", url: origin },
      { id: "WH-STORE", url: `${origin}${STORE_WEBHOOK_PATH}` },
    ]);
    const out = await verifySignature(signedHeaders(), { id: "E-1" }, CREDS, origin, fetchImpl);
    expect(out.verified).toBe(true);
    expect(verifyBodies).toEqual([expect.objectContaining({ webhook_id: "WH-STORE" })]);
  });
});

describe("verifySignature refuses junk before any PayPal call", () => {
  const full = () =>
    new Headers({
      "paypal-cert-url": "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-1",
      "paypal-auth-algo": "SHA256withRSA",
      "paypal-transmission-id": "T-1",
      "paypal-transmission-sig": "sig",
      "paypal-transmission-time": "2026-10-23T00:00:00Z",
    });

  it("refuses an unsigned request with no network call at all", async () => {
    const origin = freshOrigin();
    const { fetchImpl, calls } = fakePaypal([{ id: "WH-STORE", url: `${origin}${STORE_WEBHOOK_PATH}` }]);
    const out = await verifySignature(new Headers(), { id: "E-1" }, CREDS, origin, fetchImpl);
    expect(out.verified).toBe(false);
    expect(out.detail).toContain("paypal-transmission-sig");
    expect(calls).toEqual([]);
  });

  it("names the one header that is missing", async () => {
    const origin = freshOrigin();
    const { fetchImpl, calls } = fakePaypal([]);
    const h = full();
    h.delete("paypal-transmission-time");
    const out = await verifySignature(h, { id: "E-1" }, CREDS, origin, fetchImpl);
    expect(out).toEqual({ verified: false, detail: "missing paypal-transmission-time" });
    expect(calls).toEqual([]);
  });

  it("refuses a non-PayPal cert host with no network call", async () => {
    const origin = freshOrigin();
    const { fetchImpl, calls } = fakePaypal([]);
    const h = full();
    h.set("paypal-cert-url", "https://evil.test/cert");
    const out = await verifySignature(h, { id: "E-1" }, CREDS, origin, fetchImpl);
    expect(out.verified).toBe(false);
    expect(calls).toEqual([]);
  });
});
