import { describe, expect, it } from "vitest";
import { seedOf } from "../src/core/idempotency";
import { type RunState, initRunState, recordOutcome } from "../src/core/runState";
import type { Scenario } from "../src/core/scenario";
import { type ExecutorDeps, executeScenario } from "../src/executor/executor";
import { resendWebhookHandler } from "../src/executor/handlers/resendWebhook";
import type { HandlerRegistry, StepHandler } from "../src/executor/types";
import { type FakeResponse, fakePaypal, scenarioWith } from "./helpers/fakePaypal";

const ran: string[] = [];

const okHandler: StepHandler = async (ctx) => {
  ran.push(ctx.step.id);
  return {
    kind: "success",
    detail: `ran ${ctx.step.id}`,
    ids: { [`${ctx.step.id}_id`]: `ID-${ctx.step.id}` },
  };
};

function registry(overrides: Partial<Record<string, StepHandler>> = {}): HandlerRegistry {
  const all: Record<string, StepHandler> = {
    card_order: okHandler,
    refund: okHandler,
    payout_batch: okHandler,
    invoice_create: okHandler,
    invoice_send: okHandler,
    invoice_record_payment: okHandler,
    invoice_cancel: okHandler,
    open_dispute: okHandler,
  };
  return { ...all, ...overrides } as unknown as HandlerRegistry;
}

function harness(
  over: Partial<ExecutorDeps> = {},
  sellerQueue: FakeResponse[] = [],
) {
  const persisted: RunState[] = [];
  const logs: string[] = [];
  const seller = fakePaypal(sellerQueue, "seller");
  const buyer = fakePaypal([], "buyer");
  let clock = Date.parse("2026-10-23T12:00:00.000Z");

  const deps: ExecutorDeps = {
    seller: seller.client,
    buyer: buyer.client,
    claimPurchase: () => ({ ok: false, error: "the purchase bank is empty" }),
    persist: (s) => persisted.push(s),
    now: () => new Date((clock += 1000)),
    sleep: async () => {},
    log: (l) => logs.push(l),
    handlers: registry(),
    ...over,
  };
  return { deps, persisted, logs, sellerCalls: seller.calls };
}

const twoStep = (): Scenario =>
  scenarioWith([
    { id: "o1", kind: "card_order", amount: "40.00" },
    { id: "r1", kind: "refund", from: "o1", mode: "full", needs: ["o1"] },
  ]);

describe("executeScenario orchestration", () => {
  it("runs steps in dependency order", async () => {
    ran.length = 0;
    const h = harness();
    const state = await executeScenario({ scenario: twoStep(), runId: "run-1" }, h.deps);
    expect(ran).toEqual(["o1", "r1"]);
    expect(state.halted).toBe(false);
    expect(Object.values(state.steps).every((s) => s.status === "succeeded")).toBe(true);
  });

  it("persists after every state change, so an interrupted run can resume", async () => {
    const h = harness();
    await executeScenario({ scenario: twoStep(), runId: "run-1" }, h.deps);
    // init, then start plus outcome for each of two steps.
    expect(h.persisted.length).toBeGreaterThanOrEqual(5);
  });

  it("derives the idempotency seed from the run id and the step id", async () => {
    const seen: string[] = [];
    const capture: StepHandler = async (ctx) => {
      seen.push(ctx.seed);
      return { kind: "success", detail: "ok" };
    };
    const h = harness({ handlers: registry({ card_order: capture, refund: capture }) });
    await executeScenario({ scenario: twoStep(), runId: "run-xyz" }, h.deps);
    expect(seen[0]).toBe(seedOf(["run", "run-xyz", "step", "o1"]));
    expect(seen[1]).toBe(seedOf(["run", "run-xyz", "step", "r1"]));
    expect(seen[0]).not.toBe(seen[1]);
  });

  // Regression: a step with two writes composed seedOf([ctx.seed, "create"]),
  // but ctx.seed is already separator-joined, so the collision guard threw
  // mid-run and halted a scenario that had nothing wrong with it.
  it("composes a multi-write seed from parts without tripping the collision guard", async () => {
    const seen: string[] = [];
    const multi: StepHandler = async (ctx) => {
      seen.push(ctx.seedFor("invoice-number"), ctx.seedFor("create"), ctx.seed);
      return { kind: "success", detail: "ok" };
    };
    const h = harness({ handlers: registry({ card_order: multi, refund: multi }) });
    const state = await executeScenario({ scenario: twoStep(), runId: "run-m" }, h.deps);
    expect(state.halted).toBe(false);
    expect(seen[0]).toBe(seedOf(["run", "run-m", "step", "o1", "invoice-number"]));
    expect(seen[1]).toBe(seedOf(["run", "run-m", "step", "o1", "create"]));
    expect(new Set(seen.slice(0, 3)).size).toBe(3);
  });

  it("shows a later step the ids an earlier step recorded", async () => {
    let seenCapture: string | undefined;
    const reader: StepHandler = async (ctx) => {
      seenCapture = ctx.outputs.get("o1")?.["o1_id"];
      return { kind: "success", detail: "ok" };
    };
    const h = harness({ handlers: registry({ refund: reader }) });
    await executeScenario({ scenario: twoStep(), runId: "run-1" }, h.deps);
    expect(seenCapture).toBe("ID-o1");
  });

  it("records every id on the run state", async () => {
    const h = harness();
    const state = await executeScenario({ scenario: twoStep(), runId: "run-1" }, h.deps);
    expect(state.steps["o1"]!.ids).toEqual({ o1_id: "ID-o1" });
    expect(state.steps["r1"]!.ids).toEqual({ r1_id: "ID-r1" });
  });
});

describe("executeScenario fails closed", () => {
  it("halts on an unknown outcome and never runs the dependent step", async () => {
    ran.length = 0;
    const bad: StepHandler = async () => ({ kind: "unknown", detail: "http 500 mid-capture" });
    const h = harness({ handlers: registry({ card_order: bad }) });
    const state = await executeScenario({ scenario: twoStep(), runId: "run-1" }, h.deps);
    expect(state.halted).toBe(true);
    expect(state.haltReason).toMatch(/unknown state/i);
    expect(ran).not.toContain("r1");
    expect(state.steps["r1"]!.status).toBe("pending");
  });

  it("halts on a failure", async () => {
    const bad: StepHandler = async () => ({ kind: "failed", detail: "card declined" });
    const h = harness({ handlers: registry({ card_order: bad }) });
    const state = await executeScenario({ scenario: twoStep(), runId: "run-1" }, h.deps);
    expect(state.halted).toBe(true);
    expect(state.steps["r1"]!.status).toBe("pending");
  });

  // A throw mid-write says nothing about whether the write landed.
  it("turns a thrown handler into an unknown outcome, not a crash", async () => {
    const boom: StepHandler = async () => {
      throw new Error("socket hang up");
    };
    const h = harness({ handlers: registry({ card_order: boom }) });
    const state = await executeScenario({ scenario: twoStep(), runId: "run-1" }, h.deps);
    expect(state.steps["o1"]!.status).toBe("unknown");
    expect(state.steps["o1"]!.detail).toMatch(/socket hang up/);
    expect(state.halted).toBe(true);
  });

  it("halts when a step kind has no handler", async () => {
    const partial = { ...registry() } as Record<string, StepHandler | undefined>;
    delete partial["refund"];
    const h = harness({ handlers: partial as unknown as HandlerRegistry });
    const state = await executeScenario({ scenario: twoStep(), runId: "run-1" }, h.deps);
    expect(state.steps["r1"]!.status).toBe("unknown");
    expect(state.steps["r1"]!.detail).toMatch(/no handler/i);
    expect(state.halted).toBe(true);
  });
});

describe("executeScenario resume", () => {
  it("skips a step that already succeeded", async () => {
    ran.length = 0;
    const scenario = twoStep();
    const prior = recordOutcome(
      initRunState({
        runId: "run-1",
        scenarioName: scenario.name,
        currency: scenario.currency,
        steps: scenario.steps.map((s) => ({ id: s.id, kind: s.kind })),
        order: ["o1", "r1"],
        nowIso: "2026-10-23T11:00:00.000Z",
      }),
      "o1",
      { kind: "success", detail: "done earlier", ids: { o1_id: "ID-o1" } },
      "2026-10-23T11:00:01.000Z",
    );

    const h = harness();
    const state = await executeScenario({ scenario, runId: "run-1", resume: prior }, h.deps);
    expect(ran).toEqual(["r1"]);
    expect(state.steps["o1"]!.detail).toBe("done earlier");
    expect(state.steps["r1"]!.status).toBe("succeeded");
  });

  // Resuming onto a different scenario could re-run or skip a money movement.
  it("refuses to resume a run whose steps do not match the scenario", async () => {
    const other = scenarioWith([{ id: "different", kind: "card_order", amount: "1.00" }]);
    const prior = initRunState({
      runId: "run-1",
      scenarioName: other.name,
      currency: "USD",
      steps: other.steps.map((s) => ({ id: s.id, kind: s.kind })),
      order: ["different"],
      nowIso: "2026-10-23T11:00:00.000Z",
    });
    const h = harness();
    await expect(
      executeScenario({ scenario: twoStep(), runId: "run-1", resume: prior }, h.deps),
    ).rejects.toThrow(/cannot be resumed/i);
  });
});

describe("executeScenario webhook registration", () => {
  const withWebhook = (): Scenario => {
    const r = scenarioWith([{ id: "o1", kind: "card_order", amount: "40.00" }]);
    return { ...r, webhook: { target: "https://store.test/hook", eventTypes: ["*"] } };
  };

  it("registers a webhook and records its id on the run", async () => {
    const h = harness({}, [{ status: 201, body: { id: "WH-1" } }]);
    const state = await executeScenario({ scenario: withWebhook(), runId: "run-1" }, h.deps);
    expect(state.meta["webhook_id"]).toBe("WH-1");
    expect(h.sellerCalls[0]!.path).toBe("/v1/notifications/webhooks");
    expect((h.sellerCalls[0]!.body as any)["event_types"]).toEqual([{ name: "*" }]);
    expect(state.halted).toBe(false);
  });

  it("reuses an existing registration for the same url", async () => {
    const h = harness({}, [
      { status: 400, body: { name: "WEBHOOK_URL_ALREADY_EXISTS" } },
      { status: 200, body: { webhooks: [{ id: "WH-OLD", url: "https://store.test/hook" }] } },
    ]);
    const state = await executeScenario({ scenario: withWebhook(), runId: "run-1" }, h.deps);
    expect(state.meta["webhook_id"]).toBe("WH-OLD");
  });

  // A scenario that asked for events must not run silently without them.
  it("halts before any step when the webhook cannot be registered", async () => {
    ran.length = 0;
    const h = harness({}, [
      { status: 400, body: { name: "NOPE" } },
      { status: 200, body: { webhooks: [] } },
    ]);
    const state = await executeScenario({ scenario: withWebhook(), runId: "run-1" }, h.deps);
    expect(state.halted).toBe(true);
    expect(state.haltReason).toMatch(/events would go nowhere/i);
    expect(ran).toHaveLength(0);
  });

  it("does not re-register on resume", async () => {
    const scenario = withWebhook();
    const prior = {
      ...initRunState({
        runId: "run-1",
        scenarioName: scenario.name,
        currency: "USD",
        steps: scenario.steps.map((s) => ({ id: s.id, kind: s.kind })),
        order: ["o1"],
        nowIso: "2026-10-23T11:00:00.000Z",
      }),
      meta: { webhook_id: "WH-ALREADY" },
    };
    const h = harness({}, []);
    const state = await executeScenario({ scenario, runId: "run-1", resume: prior }, h.deps);
    expect(state.meta["webhook_id"]).toBe("WH-ALREADY");
    expect(h.sellerCalls).toHaveLength(0);
  });
});

describe("executeScenario in reuse-only webhook mode", () => {
  const TARGET = "https://store.test/api/paypal/webhook";
  const withWebhook = (): Scenario => {
    const r = scenarioWith([{ id: "o1", kind: "card_order", amount: "40.00" }]);
    return { ...r, webhook: { target: TARGET, eventTypes: ["*"] } };
  };
  const run = (h: ReturnType<typeof harness>) =>
    executeScenario({ scenario: withWebhook(), runId: "run-1", webhookMode: "reuse-only" }, h.deps);

  it("uses the one webhook at the exact target and never registers", async () => {
    const h = harness({}, [
      {
        status: 200,
        body: {
          webhooks: [
            { id: "WH-BARE", url: "https://store.test" },
            { id: "WH-STORE", url: TARGET },
          ],
        },
      },
    ]);
    const state = await run(h);
    expect(state.meta["webhook_id"]).toBe("WH-STORE");
    expect(state.halted).toBe(false);
    expect(h.sellerCalls.every((c) => c.method === "GET")).toBe(true);
  });

  it("halts before any step, without registering, when no webhook is at the target", async () => {
    ran.length = 0;
    const h = harness({}, [
      { status: 200, body: { webhooks: [{ id: "WH-BARE", url: "https://store.test" }] } },
    ]);
    const state = await run(h);
    expect(state.halted).toBe(true);
    expect(state.haltReason).toMatch(/never registers one/);
    expect(ran).toHaveLength(0);
    expect(h.sellerCalls.some((c) => c.method === "POST")).toBe(false);
  });

  it("halts when two webhooks share the exact target", async () => {
    ran.length = 0;
    const h = harness({}, [
      {
        status: 200,
        body: { webhooks: [{ id: "WH-A", url: TARGET }, { id: "WH-B", url: TARGET }] },
      },
    ]);
    const state = await run(h);
    expect(state.halted).toBe(true);
    expect(state.haltReason).toMatch(/2 webhooks/);
    expect(ran).toHaveLength(0);
  });

  // The client turns transport errors into a status, but a refused token throws.
  it("halts rather than throws when the lookup itself throws", async () => {
    const throwing = {
      call: async () => {
        throw new Error("sandbox token request failed");
      },
    } as unknown as ExecutorDeps["seller"];
    const h = harness({ seller: throwing });
    const state = await run(h);
    expect(state.halted).toBe(true);
    expect(state.haltReason).toBe(
      "could not read the webhook list: sandbox token request failed",
    );
  });

  it("treats an unreadable list as a halt, not as an empty one", async () => {
    const h = harness({}, [{ status: 403, body: {} }]);
    const state = await run(h);
    expect(state.halted).toBe(true);
    expect(state.haltReason).toMatch(/http 403/);
    expect(h.sellerCalls.some((c) => c.method === "POST")).toBe(false);
  });
});

// The finder's whole chain: the reuse-only lookup picks the store's webhook,
// and the real resend handler names exactly that webhook and no other, so
// PayPal redelivers to the store and not to every webhook on the account.
describe("a finder-mode resend names only the store's webhook", () => {
  const STORE_HOOK = "https://store.test/api/paypal/webhook";
  const STORE_ID = "4DE52141J0303334X";

  it("sends webhook_ids [the reused store webhook] and nothing else", async () => {
    const card: StepHandler = async () => ({
      kind: "success",
      detail: "captured",
      ids: { capture_id: "CAP-1" },
    });
    const scenario: Scenario = {
      ...scenarioWith([
        { id: "order", kind: "card_order", amount: "25.00" },
        {
          id: "resend-capture",
          kind: "resend_webhook",
          from: "order",
          eventType: "PAYMENT.CAPTURE.COMPLETED",
          needs: ["order"],
        },
      ]),
      webhook: { target: STORE_HOOK, eventTypes: ["*"] },
    };
    const h = harness(
      { handlers: registry({ card_order: card, resend_webhook: resendWebhookHandler }) },
      [
        {
          status: 200,
          body: {
            webhooks: [
              { id: "9FU40962XL437872W", url: "https://receiver.test/api/paypal/webhook" },
              { id: STORE_ID, url: STORE_HOOK },
            ],
          },
        },
        {
          status: 200,
          body: { events: [{ id: "WH-EV-1", event_type: "PAYMENT.CAPTURE.COMPLETED", create_time: "2026-10-23T12:00:00Z" }] },
        },
        { status: 202 },
      ],
    );

    const state = await executeScenario(
      { scenario, runId: "run-1", webhookMode: "reuse-only" },
      h.deps,
    );

    expect(state.halted).toBe(false);
    const resends = h.sellerCalls.filter((c) => c.path.endsWith("/resend"));
    expect(resends).toHaveLength(1);
    expect(resends[0]!.path).toBe("/v1/notifications/webhooks-events/WH-EV-1/resend");
    expect(resends[0]!.body).toEqual({ webhook_ids: [STORE_ID] });
    expect(h.sellerCalls.some((c) => c.method === "POST" && c.path === "/v1/notifications/webhooks")).toBe(false);
  });
});
