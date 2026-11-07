import { describe, expect, it } from "vitest";
import { PaypalClient } from "../src/adapters/paypal";
import { HostRefusedError } from "../src/core/host";
import { requestId } from "../src/core/idempotency";

const CREDS = { clientId: "cid-abc123", clientSecret: "csecret-shhh-xyz" };
const TOKEN = "A21AA-fake-access-token";

type Step =
  | { kind: "json"; status: number; body?: unknown; headers?: Record<string, string> }
  | { kind: "throw"; name: string; message: string };

const tokenOk = (): Step => ({
  kind: "json",
  status: 200,
  body: { access_token: TOKEN, expires_in: 32_400, app_id: "APP-TEST", scope: "a b" },
});

function harness(steps: Step[], extra: { minIntervalMs?: number } = {}) {
  const calls: Array<{
    url: string;
    method: string;
    headers: Record<string, string>;
    body: string | null;
  }> = [];
  const sleeps: number[] = [];
  const logs: string[] = [];
  let clock = 1_700_000_000_000;

  const fetchImpl = (async (input: unknown, init: Record<string, unknown>) => {
    calls.push({
      url: String(input),
      method: String(init["method"] ?? "GET"),
      headers: { ...((init["headers"] ?? {}) as Record<string, string>) },
      body: (init["body"] ?? null) as string | null,
    });
    const step = steps.shift();
    if (step === undefined) throw new Error("fake fetch ran out of queued steps");
    if (step.kind === "throw") {
      const e = new Error(step.message);
      e.name = step.name;
      throw e;
    }
    return new Response(step.body === undefined ? null : JSON.stringify(step.body), {
      status: step.status,
      headers: { "content-type": "application/json", ...(step.headers ?? {}) },
    });
  }) as unknown as typeof fetch;

  const client = new PaypalClient(CREDS, {
    fetchImpl,
    now: () => clock,
    rand: () => 0.5,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      clock += ms;
    },
    log: (l: string) => logs.push(l),
    label: "test",
    policy: { maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 30_000 },
    ...extra,
  });

  const apiCalls = () => calls.filter((c) => !c.url.includes("/v1/oauth2/token"));
  const tokenCalls = () => calls.filter((c) => c.url.includes("/v1/oauth2/token"));
  return { client, calls, apiCalls, tokenCalls, sleeps, logs };
}

describe("PaypalClient guards", () => {
  // The hard rule is that every write carries an idempotency key. If the key is
  // optional in practice, the rule is decorative.
  it("refuses a POST with no idempotency seed, before touching the network", async () => {
    const h = harness([]);
    await expect(
      h.client.call({ method: "POST", path: "/v2/checkout/orders", body: {} }),
    ).rejects.toThrow(/idempotencySeed/);
    expect(h.calls).toHaveLength(0);
  });

  it.each(["POST", "PUT", "PATCH"])("refuses an unkeyed %s", async (method) => {
    const h = harness([]);
    await expect(h.client.call({ method, path: "/v1/x", body: {} })).rejects.toThrow(
      /idempotencySeed/,
    );
  });

  it("allows an unkeyed GET", async () => {
    const h = harness([tokenOk(), { kind: "json", status: 200, body: { status: "OK" } }]);
    expect((await h.client.call({ method: "GET", path: "/v1/x" })).status).toBe(200);
  });

  // The message reaches step details, run reports and MCP tool output.
  it("reports a failed token request by status and error code, never the body", async () => {
    const h = harness([
      {
        kind: "json",
        status: 401,
        body: { error: "invalid_client", error_description: "Client Authentication failed BODY-TEXT" },
      },
    ]);
    await expect(h.client.accessToken()).rejects.toThrow(
      /^sandbox token request failed with http 401 \(invalid_client\)$/,
    );
  });

  it("drops an error code that is not a plain identifier", async () => {
    const h = harness([{ kind: "json", status: 400, body: { error: "x\u001b[2J; BODY-TEXT" } }]);
    await expect(h.client.accessToken()).rejects.toThrow(/^sandbox token request failed with http 400$/);
  });

  it("refuses a path that could leave the sandbox host", async () => {
    const h = harness([]);
    for (const path of ["v1/x", "@evil.test/x", "https://evil.test/x"]) {
      await expect(h.client.call({ method: "GET", path }), path).rejects.toThrow(HostRefusedError);
    }
    expect(h.calls).toHaveLength(0);
  });
});

describe("PaypalClient content type", () => {
  // Regression: PayPal returned 415 UNSUPPORTED_MEDIA_TYPE on a bodyless POST
  // because no Content-Type was sent. Orders capture and the invoice-number
  // generator are both bodyless writes, so this bit two endpoints.
  it("sends Content-Type application/json on a write with no body", async () => {
    const h = harness([tokenOk(), { kind: "json", status: 200, body: { invoice_number: "0001" } }]);
    await h.client.call({
      method: "POST",
      path: "/v2/invoicing/generate-next-invoice-number",
      idempotencySeed: "s",
    });
    const call = h.apiCalls()[0]!;
    expect(call.headers["Content-Type"]).toBe("application/json");
    expect(call.body).toBeNull();
  });

  it("sends Content-Type application/json on a write with a body", async () => {
    const h = harness([tokenOk(), { kind: "json", status: 201, body: { status: "COMPLETED" } }]);
    await h.client.call({ method: "POST", path: "/v1/x", body: { a: 1 }, idempotencySeed: "s" });
    expect(h.apiCalls()[0]!.headers["Content-Type"]).toBe("application/json");
  });

  it("sends no Content-Type on a read", async () => {
    const h = harness([tokenOk(), { kind: "json", status: 200, body: {} }]);
    await h.client.call({ method: "GET", path: "/v1/x" });
    expect(h.apiCalls()[0]!.headers["Content-Type"]).toBeUndefined();
  });
});

describe("PaypalClient idempotency", () => {
  it("sends a derived PayPal-Request-Id and reuses it across a retry", async () => {
    const h = harness([
      tokenOk(),
      { kind: "json", status: 429, headers: { "retry-after": "2" }, body: { name: "RATE_LIMIT" } },
      { kind: "json", status: 201, body: { id: "ORD-1", status: "COMPLETED" } },
    ]);

    const r = await h.client.call({
      method: "POST",
      path: "/v2/checkout/orders",
      body: { x: 1 },
      idempotencySeed: "gate1:create-order",
    });

    expect(r.status).toBe(201);
    expect(r.attempts).toBe(2);
    expect(h.sleeps).toEqual([2000]);

    const api = h.apiCalls();
    expect(api).toHaveLength(2);
    expect(api[0]!.headers["PayPal-Request-Id"]).toBe(requestId("gate1:create-order"));
    // Same key on the retry, or the retry is a second order.
    expect(api[1]!.headers["PayPal-Request-Id"]).toBe(api[0]!.headers["PayPal-Request-Id"]);
    expect(r.requestIdSent).toBe(requestId("gate1:create-order"));
  });

  it("sends no PayPal-Request-Id on a read", async () => {
    const h = harness([tokenOk(), { kind: "json", status: 200, body: {} }]);
    await h.client.call({ method: "GET", path: "/v1/x" });
    expect(h.apiCalls()[0]!.headers["PayPal-Request-Id"]).toBeUndefined();
  });
});

describe("PaypalClient auth", () => {
  it("fetches the token once and reuses it", async () => {
    const h = harness([
      tokenOk(),
      { kind: "json", status: 200, body: { status: "OK" } },
      { kind: "json", status: 200, body: { status: "OK" } },
    ]);
    await h.client.call({ method: "GET", path: "/v1/a" });
    await h.client.call({ method: "GET", path: "/v1/b" });
    expect(h.tokenCalls()).toHaveLength(1);
  });

  it("sends Basic only to the token endpoint and Bearer everywhere else", async () => {
    const h = harness([tokenOk(), { kind: "json", status: 200, body: {} }]);
    await h.client.call({ method: "GET", path: "/v1/a" });
    expect(h.tokenCalls()[0]!.headers["Authorization"]).toMatch(/^Basic /);
    expect(h.apiCalls()[0]!.headers["Authorization"]).toBe(`Bearer ${TOKEN}`);
    expect(h.apiCalls().every((c) => !String(c.headers["Authorization"]).startsWith("Basic"))).toBe(
      true,
    );
  });

  it("re-authenticates on the next call after a 401", async () => {
    const h = harness([
      tokenOk(),
      { kind: "json", status: 401, body: { name: "NOT_AUTHORIZED" } },
      tokenOk(),
      { kind: "json", status: 200, body: { status: "OK" } },
    ]);
    const first = await h.client.call({ method: "GET", path: "/v1/a" });
    expect(first.status).toBe(401);
    expect(first.attempts).toBe(1); // 401 is terminal, not retried in place
    await h.client.call({ method: "GET", path: "/v1/b" });
    expect(h.tokenCalls()).toHaveLength(2);
  });

  it("exposes non-secret token metadata only", async () => {
    const h = harness([tokenOk(), { kind: "json", status: 200, body: {} }]);
    await h.client.call({ method: "GET", path: "/v1/a" });
    expect(h.client.tokenMeta).toEqual({ appId: "APP-TEST", scopes: ["a", "b"], expiresInSec: 32_400 });
    expect(JSON.stringify(h.client.tokenMeta)).not.toContain(TOKEN);
  });
});

describe("PaypalClient with replayIfAmbiguous false", () => {
  const write = (h: ReturnType<typeof harness>) =>
    h.client.call({
      method: "POST",
      path: "/v1/a",
      body: {},
      idempotencySeed: "s",
      replayIfAmbiguous: false,
    });

  // PayPal may have acted on any of these, so a replay could act twice.
  it("returns the first 5xx, timeout or 408 instead of replaying it", async () => {
    for (const answer of [
      { kind: "json", status: 503 } as const,
      { kind: "json", status: 500 } as const,
      { kind: "json", status: 408 } as const,
      { kind: "throw", name: "TimeoutError", message: "timed out" } as const,
    ]) {
      const h = harness([tokenOk(), answer, { kind: "json", status: 202 }]);
      const r = await write(h);
      expect(r.attempts, JSON.stringify(answer)).toBe(1);
      expect(h.apiCalls(), JSON.stringify(answer)).toHaveLength(1);
      expect(h.sleeps).toEqual([]);
    }
  });

  it("still retries a 429, which is a refusal rather than an ambiguous outcome", async () => {
    const h = harness([tokenOk(), { kind: "json", status: 429 }, { kind: "json", status: 202 }]);
    const r = await write(h);
    expect(r.status).toBe(202);
    expect(h.apiCalls()).toHaveLength(2);
  });

  it("leaves the default unchanged: an unmarked write still retries a 503", async () => {
    const h = harness([tokenOk(), { kind: "json", status: 503 }, { kind: "json", status: 202 }]);
    const r = await h.client.call({ method: "POST", path: "/v1/a", body: {}, idempotencySeed: "s" });
    expect(r.status).toBe(202);
    expect(h.apiCalls()).toHaveLength(2);
  });
});

describe("PaypalClient retry and throttle", () => {
  it("reports a transport failure as status 0 once the budget is spent", async () => {
    const h = harness([
      tokenOk(),
      { kind: "throw", name: "TimeoutError", message: "timed out" },
      { kind: "throw", name: "TimeoutError", message: "timed out" },
      { kind: "throw", name: "TimeoutError", message: "timed out" },
    ]);
    const r = await h.client.call({ method: "GET", path: "/v1/a" });
    expect(r.status).toBe(0);
    expect(r.attempts).toBe(3);
    expect(r.transportError).toMatch(/TimeoutError/);
  });

  it("does not retry a 422", async () => {
    const h = harness([tokenOk(), { kind: "json", status: 422, body: { name: "UNPROCESSABLE" } }]);
    const r = await h.client.call({
      method: "POST",
      path: "/v1/a",
      body: {},
      idempotencySeed: "s",
    });
    expect(r.attempts).toBe(1);
    expect(h.sleeps).toEqual([]);
  });

  it("captures the paypal-debug-id for reporting", async () => {
    const h = harness([
      tokenOk(),
      { kind: "json", status: 200, body: {}, headers: { "paypal-debug-id": "dbg-123" } },
    ]);
    expect((await h.client.call({ method: "GET", path: "/v1/a" })).debugId).toBe("dbg-123");
  });

  it("self-throttles to the minimum interval", async () => {
    const h = harness(
      [tokenOk(), { kind: "json", status: 200, body: {} }, { kind: "json", status: 200, body: {} }],
      { minIntervalMs: 500 },
    );
    await h.client.call({ method: "GET", path: "/v1/a" });
    await h.client.call({ method: "GET", path: "/v1/b" });
    expect(h.sleeps).toEqual([500]);
  });
});

describe("PaypalClient logging", () => {
  it("never writes the client secret, client id or access token to the log", async () => {
    const h = harness([
      tokenOk(),
      { kind: "json", status: 429, headers: { "retry-after": "1" }, body: {} },
      { kind: "json", status: 201, body: { status: "COMPLETED" } },
    ]);
    await h.client.call({
      method: "POST",
      path: "/v2/checkout/orders",
      body: {},
      idempotencySeed: "s",
    });
    const all = h.logs.join("\n");
    expect(all).not.toContain(CREDS.clientSecret);
    expect(all).not.toContain(CREDS.clientId);
    expect(all).not.toContain(TOKEN);
    expect(all).toContain("POST /v2/checkout/orders");
  });
});

// The host pin checks the first URL only. A followed redirect would carry the
// bearer token, or the Basic credentials, to a host nobody pinned.
describe("redirects", () => {
  it("are refused on the token request and on every call", async () => {
    const seen: unknown[] = [];
    const fetchImpl = (async (input: unknown, init: Record<string, unknown>) => {
      seen.push(init["redirect"]);
      const body = String(input).endsWith("/v1/oauth2/token")
        ? { access_token: TOKEN, expires_in: 32_400 }
        : { id: "X" };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const client = new PaypalClient(CREDS, { fetchImpl, sleep: async () => {} });
    await client.call({ method: "GET", path: "/v2/checkout/orders/X" });
    await client.call({ method: "POST", path: "/v2/checkout/orders", idempotencySeed: "s", body: {} });
    expect(seen).toEqual(["error", "error", "error"]);
  });
});

// The hosted worker's time budget counts each attempt at its own timeout, so
// the client must stop waiting there, not at the engine's 30 s default.
describe("requestTimeoutMs", () => {
  it("bounds each attempt, token request included", async () => {
    const hang = (async (_input: unknown, init: Record<string, unknown>) =>
      new Promise((_resolve, reject) => {
        (init["signal"] as AbortSignal).addEventListener("abort", () => reject(new DOMException("timed out", "TimeoutError")));
      })) as unknown as typeof fetch;
    const started = Date.now();
    const client = new PaypalClient(CREDS, { fetchImpl: hang, requestTimeoutMs: 50, sleep: async () => {} });
    await expect(client.call({ method: "GET", path: "/v2/checkout/orders/X" })).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(5_000);

    let tokenServed = false;
    const slowCall = (async (input: unknown, init: Record<string, unknown>) => {
      if (String(input).endsWith("/v1/oauth2/token")) {
        tokenServed = true;
        return new Response(JSON.stringify({ access_token: TOKEN, expires_in: 32_400 }), { status: 200 });
      }
      return hang(input as string, init as RequestInit);
    }) as unknown as typeof fetch;
    const c2 = new PaypalClient(CREDS, { fetchImpl: slowCall, requestTimeoutMs: 50, sleep: async () => {}, policy: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 } });
    const res = await c2.call({ method: "GET", path: "/v2/checkout/orders/X" });
    expect(tokenServed).toBe(true);
    expect(res.status).toBe(0);
    expect(res.transportError).toMatch(/TimeoutError/);
  });
});
