import { describe, expect, it } from "vitest";
import { initRunState, recordMeta, recordOutcome } from "../src/core/runState";
import type { Scenario } from "../src/core/scenario";
import { runReportLines } from "../src/executor/report";
import { scenarioWith } from "./helpers/fakePaypal";

const T = "2026-10-23T12:00:00.000Z";

const scenario = (): Scenario =>
  scenarioWith([
    { id: "o1", kind: "card_order", amount: "40.00" },
    { id: "p1", kind: "payout_batch", items: [{ amount: "5.00", unclaimed: true }] },
    { id: "i1", kind: "invoice_create", amount: "25.00" },
  ]);

const start = (s: Scenario) =>
  initRunState({
    runId: "run-abc",
    scenarioName: s.name,
    currency: s.currency,
    steps: s.steps.map((x) => ({ id: x.id, kind: x.kind })),
    order: ["o1", "p1", "i1"],
    nowIso: T,
  });

const text = (s: Scenario, state: Parameters<typeof runReportLines>[1]) =>
  runReportLines(s, state).join("\n");

describe("runReportLines", () => {
  it("reports COMPLETE when every step succeeded", () => {
    const s = scenario();
    let state = start(s);
    for (const id of ["o1", "p1", "i1"]) {
      state = recordOutcome(state, id, { kind: "success", detail: "ok" }, T);
    }
    const out = text(s, state);
    expect(out).toContain("**Verdict:** COMPLETE");
    expect(out).toContain("3 succeeded");
  });

  it("reports HALTED and names the step that stopped it", () => {
    const s = scenario();
    let state = recordOutcome(start(s), "o1", { kind: "success", detail: "ok" }, T);
    state = recordOutcome(state, "p1", { kind: "unknown", detail: "item stuck PENDING" }, T);
    const out = text(s, state);
    expect(out).toContain("**Verdict:** HALTED");
    expect(out).toContain("item stuck PENDING");
    expect(out).toContain("| `i1` | invoice_create | not run |");
  });

  it("lists every PayPal id with the step that created it", () => {
    const s = scenario();
    let state = recordOutcome(
      start(s),
      "o1",
      { kind: "success", detail: "ok", ids: { order_id: "ORD-9", capture_id: "CAP-9" } },
      T,
    );
    state = recordOutcome(state, "p1", { kind: "success", detail: "ok", ids: { payout_batch_id: "B-9" } }, T);
    const out = text(s, state);
    expect(out).toContain("| `o1` | order_id | `ORD-9` |");
    expect(out).toContain("| `o1` | capture_id | `CAP-9` |");
    expect(out).toContain("| `p1` | payout_batch_id | `B-9` |");
  });

  it("says plainly when nothing was created", () => {
    expect(text(scenario(), start(scenario()))).toContain("Nothing was created.");
  });

  // A halted run must not claim money it never moved.
  it("counts money only for steps that succeeded", () => {
    const s = scenario();
    let state = recordOutcome(start(s), "o1", { kind: "success", detail: "ok" }, T);
    state = recordOutcome(state, "p1", { kind: "failed", detail: "declined" }, T);
    const out = text(s, state);
    expect(out).toContain("Cards charged: USD 40.00");
    expect(out).toContain("Paid out: USD 0.00");
    expect(out).toContain("Invoiced: USD 0.00");
  });

  it("includes run-level metadata such as a registered webhook", () => {
    const s = scenario();
    const state = recordMeta(start(s), "webhook_id", "WH-7", T);
    expect(text(s, state)).toContain("webhook_id: `WH-7`");
  });
});
