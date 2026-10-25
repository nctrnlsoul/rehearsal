import { beforeEach, describe, expect, it } from "vitest";
import { TOKEN_EXPIRY_MARGIN_S, accessToken, forgetToken } from "../lib/paypalToken";
import { verifySignature } from "../lib/verify";

/** A PayPal token endpoint that counts calls and hands out numbered tokens. */
function tokenServer(reply: (n: number) => { status: number; body: unknown } = (n) => ({
  status: 200,
  body: { access_token: `tok-${n}`, expires_in: 32400 },
})) {
  let n = 0;
  const fetchImpl = (async () => {
    n += 1;
    const r = reply(n);
    return new Response(JSON.stringify(r.body), { status: r.status });
  }) as unknown as typeof fetch;
  return { fetchImpl, count: () => n };
}

beforeEach(() => forgetToken());

describe("the PayPal token is fetched once and reused (M3)", () => {
  it("reuses the token for later requests", async () => {
    const s = tokenServer();
    expect(await accessToken("id", "secret", s.fetchImpl)).toBe("tok-1");
    expect(await accessToken("id", "secret", s.fetchImpl)).toBe("tok-1");
    expect(await accessToken("id", "secret", s.fetchImpl)).toBe("tok-1");
    expect(s.count()).toBe(1);
  });

  it("shares one fetch between concurrent requests on a cold instance", async () => {
    const s = tokenServer();
    const got = await Promise.all(Array.from({ length: 10 }, () => accessToken("id", "secret", s.fetchImpl)));
    expect(new Set(got)).toEqual(new Set(["tok-1"]));
    expect(s.count()).toBe(1);
  });

  it("refetches shortly before PayPal's stated expiry", async () => {
    const s = tokenServer((n) => ({ status: 200, body: { access_token: `tok-${n}`, expires_in: 3600 } }));
    let t = 1_000_000;
    const now = () => t;
    await accessToken("id", "secret", s.fetchImpl, now);
    t += (3600 - TOKEN_EXPIRY_MARGIN_S) * 1000 - 1;
    expect(await accessToken("id", "secret", s.fetchImpl, now)).toBe("tok-1");
    t += 1;
    expect(await accessToken("id", "secret", s.fetchImpl, now)).toBe("tok-2");
  });

  it("does not cache a refusal, an empty reply, or a thrown fetch", async () => {
    const s = tokenServer((n) => (n === 1 ? { status: 401, body: {} } : n === 2 ? { status: 200, body: {} } : { status: 200, body: { access_token: `tok-${n}`, expires_in: 32400 } }));
    expect(await accessToken("id", "secret", s.fetchImpl)).toBeNull();
    expect(await accessToken("id", "secret", s.fetchImpl)).toBeNull();
    expect(await accessToken("id", "secret", s.fetchImpl)).toBe("tok-3");
    const boom = (async () => {
      throw new Error("network");
    }) as unknown as typeof fetch;
    forgetToken();
    await expect(accessToken("id", "secret", boom)).rejects.toThrow("network");
    expect(await accessToken("id", "secret", s.fetchImpl)).toBe("tok-4");
  });

  it("holds a token no longer than 8 hours, whatever PayPal states", async () => {
    const s = tokenServer((n) => ({ status: 200, body: { access_token: `tok-${n}`, expires_in: 10 ** 9 } }));
    let t = 0;
    const now = () => t;
    await accessToken("id", "secret", s.fetchImpl, now);
    t = (8 * 3600 - TOKEN_EXPIRY_MARGIN_S) * 1000;
    expect(await accessToken("id", "secret", s.fetchImpl, now)).toBe("tok-2");
  });

  it("does not hold a token whose stated lifetime is inside the margin", async () => {
    const s = tokenServer((n) => ({ status: 200, body: { access_token: `tok-${n}`, expires_in: 60 } }));
    await accessToken("id", "secret", s.fetchImpl);
    await accessToken("id", "secret", s.fetchImpl);
    expect(s.count()).toBe(2);
  });

  it("never reuses a token across a changed client id or secret", async () => {
    const s = tokenServer();
    expect(await accessToken("id", "secret", s.fetchImpl)).toBe("tok-1");
    expect(await accessToken("id", "rotated", s.fetchImpl)).toBe("tok-2");
    expect(await accessToken("other", "rotated", s.fetchImpl)).toBe("tok-3");
  });
});

describe("forged requests cost one token, not one each (M3 probe)", () => {
  const signed = (i: number) =>
    new Headers({
      "paypal-transmission-id": `T-${i}`,
      "paypal-transmission-time": "2026-10-25T00:00:00Z",
      "paypal-transmission-sig": "forged",
      "paypal-auth-algo": "SHA256withRSA",
      "paypal-cert-url": "https://api.sandbox.paypal.com/v1/notifications/certs/C",
    });

  it("ten forged deliveries make one token call and ten verify calls", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      calls.push(url.replace("https://api-m.sandbox.paypal.com", ""));
      if (url.endsWith("/v1/oauth2/token")) {
        return new Response(JSON.stringify({ access_token: "tok", expires_in: 32400 }), { status: 200 });
      }
      return new Response(JSON.stringify({ verification_status: "FAILURE" }), { status: 200 });
    }) as typeof fetch;
    const env = {
      PAYPAL_SELLER_CLIENT_ID: "id",
      PAYPAL_SELLER_CLIENT_SECRET: "secret",
      REHEARSAL_STORE_WEBHOOK_ID: "WH-PINNED",
    };
    for (let i = 0; i < 10; i += 1) {
      const out = await verifySignature(signed(i), { id: `WH-${i}` }, env, fetchImpl);
      expect(out.verified).toBe(false);
    }
    expect(calls.filter((c) => c === "/v1/oauth2/token")).toHaveLength(1);
    expect(calls.filter((c) => c === "/v1/notifications/verify-webhook-signature")).toHaveLength(10);
  });

  it("drops the token when PayPal answers 401 to it", async () => {
    let tokens = 0;
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/v1/oauth2/token")) {
        tokens += 1;
        return new Response(JSON.stringify({ access_token: `tok-${tokens}`, expires_in: 32400 }), { status: 200 });
      }
      return new Response("{}", { status: 401 });
    }) as typeof fetch;
    const env = { PAYPAL_SELLER_CLIENT_ID: "id", PAYPAL_SELLER_CLIENT_SECRET: "secret", REHEARSAL_STORE_WEBHOOK_ID: "WH" };
    await verifySignature(signed(1), {}, env, fetchImpl);
    await verifySignature(signed(2), {}, env, fetchImpl);
    expect(tokens).toBe(2);
  });
});
