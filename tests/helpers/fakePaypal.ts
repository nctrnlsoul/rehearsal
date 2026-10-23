import { PaypalClient } from "../../src/adapters/paypal";
import type { Purchase } from "../../src/core/purchaseBank";
import { type Scenario, validateScenario } from "../../src/core/scenario";
import type { ClaimResult, StepContext } from "../../src/executor/types";

/**
 * Test doubles for handler tests. The token endpoint answers automatically, so a
 * queue only describes the API calls a handler is expected to make. An
 * unqueued call throws, which keeps a handler from making calls nobody asserted.
 */

export const CLOCK = Date.parse("2026-10-23T12:00:00.000Z");

export type FakeResponse = {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
};

export type RecordedCall = { method: string; path: string; body: unknown };

export function fakePaypal(queue: FakeResponse[], label = "fake") {
  const calls: RecordedCall[] = [];

  const fetchImpl = (async (input: unknown, init: Record<string, unknown>) => {
    const url = new URL(String(input));
    if (url.pathname === "/v1/oauth2/token") {
      return new Response(
        JSON.stringify({ access_token: "fake-token", expires_in: 32_400, app_id: "APP-FAKE", scope: "x" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    const raw = init["body"];
    calls.push({
      method: String(init["method"] ?? "GET"),
      path: url.pathname + url.search,
      body: typeof raw === "string" ? JSON.parse(raw) : null,
    });
    const next = queue.shift();
    if (next === undefined) {
      throw new Error(`fake paypal (${label}): no queued response for ${String(init["method"])} ${url.pathname}`);
    }
    return new Response(next.body === undefined ? null : JSON.stringify(next.body), {
      status: next.status,
      headers: { "content-type": "application/json", ...(next.headers ?? {}) },
    });
  }) as unknown as typeof fetch;

  const client = new PaypalClient(
    { clientId: "fake-id", clientSecret: "fake-secret" },
    {
      fetchImpl,
      label,
      now: () => CLOCK,
      sleep: async () => {},
      rand: () => 0.5,
      policy: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1 },
    },
  );

  return { client, calls };
}

/** Builds a real validated Scenario so handler tests see the same defaults a run does. */
export function scenarioWith(steps: unknown[], currency = "USD"): Scenario {
  const r = validateScenario(
    {
      version: 1,
      name: "handler test",
      profile: { name: "Test Shop" },
      currency,
      steps,
    },
    { allowedEventOrigins: [] },
  );
  if (!r.ok) throw new Error(`test scenario is invalid: ${r.errors.join("; ")}`);
  return r.scenario;
}

export function makePurchase(over: Partial<Purchase> = {}): Purchase {
  return {
    id: "p-1",
    orderId: "ORD-BANK-1",
    captureId: "CAP-BANK-1",
    buyerTransactionId: "TXN-BANK-1",
    amount: "88.00",
    currency: "USD",
    status: "available",
    createdAt: "2026-10-23T00:00:00.000Z",
    approvalUrl: null,
    usedByRunId: null,
    usedAt: null,
    ...over,
  };
}

export function makeContext(opts: {
  scenario: Scenario;
  stepId: string;
  seller: PaypalClient;
  buyer?: PaypalClient;
  outputs?: Record<string, Record<string, string>>;
  claim?: ClaimResult;
  env?: Record<string, string | undefined>;
}): { ctx: StepContext; logs: string[]; sleeps: number[] } {
  const step = opts.scenario.steps.find((s) => s.id === opts.stepId);
  if (step === undefined) throw new Error(`no step ${opts.stepId} in the test scenario`);

  const logs: string[] = [];
  const sleeps: number[] = [];
  const outputs = new Map<string, Record<string, string>>(
    Object.entries(opts.outputs ?? {}),
  );
  // A fake clock must ADVANCE when the code under test sleeps. Holding it still
  // turns every deadline loop into an infinite loop.
  let clock = CLOCK;

  const ctx: StepContext = {
    runId: "run-test",
    scenario: opts.scenario,
    step,
    seed: `run-test:${opts.stepId}`,
    seller: opts.seller,
    buyer: opts.buyer ?? opts.seller,
    outputs,
    claimPurchase: () => opts.claim ?? { ok: false, error: "the purchase bank is empty" },
    env: opts.env ?? {},
    now: () => new Date(clock),
    sleep: async (ms: number) => {
      sleeps.push(ms);
      clock += ms;
    },
    log: (line: string) => logs.push(line),
  };

  return { ctx, logs, sleeps };
}
