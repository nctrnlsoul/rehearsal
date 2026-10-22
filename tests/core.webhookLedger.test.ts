import { describe, expect, it } from "vitest";
import { type Arrival, type Expectation, reconcile } from "../src/core/webhookLedger";

const T = 1_700_000_000_000;

const exp = (id: string, sentAtMs = T): Expectation => ({
  eventId: id,
  eventType: "PAYMENT.CAPTURE.COMPLETED",
  sentAtMs,
});

const arr = (id: string, receivedAtMs: number, instanceId = "i1"): Arrival => ({
  eventId: id,
  eventType: "PAYMENT.CAPTURE.COMPLETED",
  receivedAtMs,
  verified: true,
  instanceId,
});

describe("reconcile", () => {
  it("passes when every expected event arrived, and reports latency", () => {
    const r = reconcile([exp("a"), exp("b")], [arr("a", T + 400), arr("b", T + 1200)]);
    expect(r.verdict).toBe("pass");
    expect(r.missing).toHaveLength(0);
    expect(r.matched.map((m) => m.latencyMs)).toEqual([400, 1200]);
  });

  it("fails and names the missing event", () => {
    const r = reconcile([exp("a"), exp("b")], [arr("a", T + 400)]);
    expect(r.verdict).toBe("fail");
    expect(r.missing.map((m) => m.eventId)).toEqual(["b"]);
  });

  // An in-memory receiver ledger read from one instance cannot see rows written
  // to another, so "missing" and "stored elsewhere" are indistinguishable.
  it("reports ambiguous, not fail, when the ledger is split across instances", () => {
    const r = reconcile([exp("a"), exp("b")], [arr("a", T + 400, "i1"), arr("b", T + 500, "i2")]);
    expect(r.degraded).toBe(true);
    expect(r.verdict).toBe("pass"); // nothing missing, so the split did not cost us

    const r2 = reconcile(
      [exp("a"), exp("b"), exp("c")],
      [arr("a", T + 400, "i1"), arr("b", T + 500, "i2")],
    );
    expect(r2.degraded).toBe(true);
    expect(r2.verdict).toBe("ambiguous");
    expect(r2.notes.join(" ")).toMatch(/instance/i);
  });

  // An empty run must never read as a pass.
  it("fails when nothing was expected", () => {
    const r = reconcile([], []);
    expect(r.verdict).toBe("fail");
    expect(r.notes.join(" ")).toMatch(/nothing was expected/i);
  });

  it("counts a redelivery of the same event once and notes it", () => {
    const r = reconcile([exp("a")], [arr("a", T + 400), arr("a", T + 9000)]);
    expect(r.verdict).toBe("pass");
    expect(r.matched).toHaveLength(1);
    expect(r.matched[0]!.duplicates).toBe(1);
    expect(r.matched[0]!.latencyMs).toBe(400); // first arrival wins
    expect(r.duplicateCount).toBe(1);
  });

  it("lists arrivals that match no expectation", () => {
    const r = reconcile([exp("a")], [arr("a", T + 10), arr("zz", T + 20)]);
    expect(r.unexpected.map((u) => u.eventId)).toEqual(["zz"]);
    expect(r.verdict).toBe("pass");
  });

  it("flags clock skew rather than reporting a negative latency silently", () => {
    const r = reconcile([exp("a")], [arr("a", T - 5000)]);
    expect(r.notes.join(" ")).toMatch(/skew/i);
    expect(r.matched[0]!.latencyMs).toBe(-5000);
  });

  it("surfaces an unverified arrival", () => {
    const r = reconcile([exp("a")], [{ ...arr("a", T + 10), verified: false }]);
    expect(r.matched[0]!.verified).toBe(false);
    expect(r.notes.join(" ")).toMatch(/signature/i);
  });
});
