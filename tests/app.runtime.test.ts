import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  NEEDS_BANKED_PURCHASE,
  RUN_ID_PATTERN,
  bankShortfall,
  eventOriginsFromEnv,
  executeWithPersistence,
  gateScenario,
  loadResume,
  newRunId,
  pathsUnder,
  runStateStore,
  storeStateReader,
} from "../src/app/runtime";
import { DEFAULT_CAPS } from "../src/core/caps";
import { type Bank, emptyBank } from "../src/core/purchaseBank";
import { initRunState, haltRun } from "../src/core/runState";
import { fakePaypal, makePurchase, scenarioWith } from "./helpers/fakePaypal";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "rehearsal-runtime-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const ORIGIN = "https://store.example.test";

describe("eventOriginsFromEnv", () => {
  it("merges the three variables and drops blanks", () => {
    const r = eventOriginsFromEnv({
      REHEARSAL_STORE_ORIGIN: ORIGIN,
      REHEARSAL_RECEIVER_ORIGIN: "  ",
      REHEARSAL_EVENT_ORIGINS: "https://a.example.test, https://a.example.test",
    });
    expect(r).toEqual({ ok: true, origins: ["https://a.example.test", ORIGIN] });
  });

  it("refuses a malformed entry without echoing it", () => {
    const r = eventOriginsFromEnv({ REHEARSAL_STORE_ORIGIN: "http://secret-host.example.test" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("REHEARSAL_STORE_ORIGIN");
      expect(r.error).not.toContain("secret-host");
    }
  });
});

describe("run ids", () => {
  it("newRunId matches the pattern run_status accepts", () => {
    expect(newRunId(new Date("2026-10-23T23:15:52.123Z"))).toMatch(/^20261023231552-[0-9a-f]{6}$/);
    expect(RUN_ID_PATTERN.test(newRunId(new Date()))).toBe(true);
  });

  it.each(["../bank/purchases", "20261023231552-60ea96/../../x", "20261023231552-60EA96", "", "x"])(
    "refuses %j as a run id before it becomes a path",
    (bad) => {
      expect(() => runStateStore(root, bad)).toThrow(/run id must look like/);
    },
  );
});

const card = () =>
  scenarioWith([{ id: "order", kind: "card_order", amount: "25.00" }]);
const dispute = () =>
  scenarioWith([{ id: "d", kind: "open_dispute" }]);

describe("gateScenario", () => {
  const raw = (over: Record<string, unknown> = {}) => ({
    version: 1,
    name: "t",
    profile: { name: "Shop" },
    currency: "USD",
    steps: [{ id: "order", kind: "card_order", amount: "25.00" }],
    ...over,
  });

  it("passes a scenario inside schema, allowlist and caps", () => {
    expect(gateScenario(raw(), { allowedEventOrigins: [], caps: DEFAULT_CAPS }).ok).toBe(true);
  });

  it("refuses a schema failure", () => {
    const r = gateScenario(raw({ steps: [] }), { allowedEventOrigins: [], caps: DEFAULT_CAPS });
    expect(r.ok).toBe(false);
  });

  it("refuses an off-allowlist webhook target", () => {
    const r = gateScenario(
      raw({ webhook: { target: "https://evil.example.test/api/paypal/webhook" } }),
      { allowedEventOrigins: [ORIGIN], caps: DEFAULT_CAPS },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(" ")).toMatch(/not on the allowlist/);
  });

  it("refuses a scenario over the caps", () => {
    const r = gateScenario(raw({ steps: [{ id: "big", kind: "card_order", amount: "500.01" }] }), {
      allowedEventOrigins: [],
      caps: DEFAULT_CAPS,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(" ")).toMatch(/per-step cap/);
  });
});

describe("bankShortfall", () => {
  const bankWith = (...statuses: Array<"available" | "used" | "awaiting_approval">): Bank => ({
    version: 1,
    purchases: statuses.map((status, i) =>
      makePurchase({ id: `p${i}`, orderId: `O${i}`, status }),
    ),
  });

  it("is short when a dispute has no usable purchase", () => {
    expect(bankShortfall(dispute(), bankWith("used", "awaiting_approval"))).toEqual({
      needed: 1,
      available: 0,
      short: true,
    });
  });

  it("is not short when a purchase is available, or when no dispute is planned", () => {
    expect(bankShortfall(dispute(), bankWith("available")).short).toBe(false);
    expect(bankShortfall(card(), emptyBank()).short).toBe(false);
  });

  it("names bank:add in the message", () => {
    expect(NEEDS_BANKED_PURCHASE).toBe("needs a banked purchase: run bank:add");
  });
});

describe("loadResume", () => {
  const write = (halted: boolean) => {
    const id = "20261023231552-60ea96";
    let state = initRunState({
      runId: id,
      scenarioName: "t",
      currency: "USD",
      steps: [{ id: "order", kind: "card_order" }],
      order: ["order"],
      nowIso: "2026-10-23T00:00:00.000Z",
    });
    if (halted) state = haltRun(state, "step order ended unknown", "2026-10-23T00:00:01.000Z");
    runStateStore(root, id).write(state);
    return id;
  };

  it("reports a missing run", () => {
    const r = loadResume(root, "20261023231552-000000", null, "now");
    expect(r).toMatchObject({ ok: false, halted: false });
  });

  it("refuses a halted run without a retry", () => {
    const r = loadResume(root, write(true), null, "now");
    expect(r).toMatchObject({ ok: false, halted: true });
  });

  it("resumes a run that was interrupted, not halted", () => {
    const r = loadResume(root, write(false), null, "now");
    expect(r.ok).toBe(true);
  });

  it("throws on a traversal id rather than reading outside runs/", () => {
    mkdirSync(join(root, "bank"), { recursive: true });
    writeFileSync(join(root, "bank", "purchases.json"), "{}");
    expect(() => loadResume(join(root, "runs"), "../bank/purchases", null, "now")).toThrow();
  });
});

describe("executeWithPersistence", () => {
  it("persists run state under runs/ and marks the banked purchase used before the dispute call", async () => {
    const paths = pathsUnder(root);
    mkdirSync(join(root, "bank"), { recursive: true });
    writeFileSync(
      paths.bankPath,
      JSON.stringify({ version: 1, purchases: [makePurchase()] }),
    );

    let bankAtDisputeCall: string | null = null;
    const buyer = fakePaypal([{ status: 500, body: { name: "INTERNAL" } }], "buyer");
    const seller = fakePaypal([], "seller");
    const realCall = buyer.client.call.bind(buyer.client);
    buyer.client.call = async (req) => {
      bankAtDisputeCall = readFileSync(paths.bankPath, "utf8");
      return realCall(req);
    };

    const runId = "20261023231552-abcdef";
    const state = await executeWithPersistence(
      { scenario: dispute(), runId, resume: null },
      {
        paths,
        seller: seller.client,
        buyer: buyer.client,
        now: () => new Date("2026-10-23T12:00:00.000Z"),
        sleep: async () => {},
        log: () => {},
        env: {},
      },
    );

    expect(bankAtDisputeCall).not.toBeNull();
    expect(JSON.parse(bankAtDisputeCall!).purchases[0].status).toBe("used");
    expect(existsSync(join(paths.runsDir, `${runId}.json`))).toBe(true);
    expect(state.halted).toBe(true);
  });
});

describe("storeStateReader", () => {
  it("sends the bearer token and the since parameter", async () => {
    let seen: { url: string; auth: string | null } | null = null;
    const read = storeStateReader({
      origin: ORIGIN,
      token: "tok-123",
      fetchImpl: (async (url: URL, init: RequestInit) => {
        seen = { url: String(url), auth: new Headers(init.headers).get("authorization") };
        return new Response(JSON.stringify({ orders: [], eventCount: 0, unverifiedCount: 0 }));
      }) as unknown as typeof fetch,
    });
    await read("2026-10-23T00:00:00.000Z");
    expect(seen!.url).toBe(`${ORIGIN}/api/store/state?since=2026-10-23T00%3A00%3A00.000Z`);
    expect(seen!.auth).toBe("Bearer tok-123");
  });

  it("throws with the status only on a non-2xx reply", async () => {
    const read = storeStateReader({
      origin: ORIGIN,
      token: "t",
      fetchImpl: (async () =>
        new Response("upstream said something long and private", { status: 502 })) as unknown as typeof fetch,
    });
    await expect(read("x")).rejects.toThrow(/^store state read returned http 502$/);
  });
});
