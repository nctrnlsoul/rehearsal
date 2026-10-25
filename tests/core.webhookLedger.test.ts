import { describe, expect, it } from "vitest";
import {
  type Arrival,
  type Expectation,
  arrivalsOf,
  receiverVerifies,
  reconcile,
} from "../src/core/webhookLedger";

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

/** Most tests assume a ledger already proved readable; that is the normal path. */
const rec = (e: readonly Expectation[], a: readonly Arrival[]) =>
  reconcile(e, a, { ledgerVerified: true });

describe("reconcile with a verified ledger", () => {
  it("passes when every expected event arrived, and reports latency", () => {
    const r = rec([exp("a"), exp("b")], [arr("a", T + 400), arr("b", T + 1200)]);
    expect(r.verdict).toBe("pass");
    expect(r.missing).toHaveLength(0);
    expect(r.matched.map((m) => m.latencyMs)).toEqual([400, 1200]);
  });

  it("fails and names the missing event", () => {
    const r = rec([exp("a"), exp("b")], [arr("a", T + 400)]);
    expect(r.verdict).toBe("fail");
    expect(r.missing.map((m) => m.eventId)).toEqual(["b"]);
  });

  it("reports ambiguous when the ledger is split across instances", () => {
    const r = rec([exp("a"), exp("b")], [arr("a", T + 400, "i1"), arr("b", T + 500, "i2")]);
    expect(r.degraded).toBe(true);
    expect(r.verdict).toBe("pass"); // nothing missing, so the split did not cost us

    const r2 = rec(
      [exp("a"), exp("b"), exp("c")],
      [arr("a", T + 400, "i1"), arr("b", T + 500, "i2")],
    );
    expect(r2.verdict).toBe("ambiguous");
    expect(r2.notes.join(" ")).toMatch(/instance/i);
  });

  it("fails when nothing was expected", () => {
    const r = rec([], []);
    expect(r.verdict).toBe("fail");
    expect(r.notes.join(" ")).toMatch(/nothing was expected/i);
  });

  it("counts a redelivery of the same event once and notes it", () => {
    const r = rec([exp("a")], [arr("a", T + 400), arr("a", T + 9000)]);
    expect(r.verdict).toBe("pass");
    expect(r.matched).toHaveLength(1);
    expect(r.matched[0]!.duplicates).toBe(1);
    expect(r.matched[0]!.latencyMs).toBe(400); // first arrival wins
    expect(r.duplicateCount).toBe(1);
  });

  it("lists arrivals that match no expectation", () => {
    const r = rec([exp("a")], [arr("a", T + 10), arr("zz", T + 20)]);
    expect(r.unexpected.map((u) => u.eventId)).toEqual(["zz"]);
    expect(r.verdict).toBe("pass");
  });

  it("flags clock skew rather than reporting a negative latency silently", () => {
    const r = rec([exp("a")], [arr("a", T - 5000)]);
    expect(r.notes.join(" ")).toMatch(/skew/i);
    expect(r.matched[0]!.latencyMs).toBe(-5000);
  });

  it("surfaces an unverified arrival", () => {
    const r = rec([exp("a")], [{ ...arr("a", T + 10), verified: false }]);
    expect(r.matched[0]!.verified).toBe(false);
    expect(r.notes.join(" ")).toMatch(/signature/i);
  });
});

describe("reconcile with an unproved ledger", () => {
  // The real failure this guards: an in-memory receiver ledger on Vercel served
  // reads from one instance while PayPal's deliveries landed on others. Zero
  // arrivals were visible, so counting instance ids could not detect the problem
  // and the old code would have called five delivered events "missing".
  it("calls everything missing AMBIGUOUS, never a confident fail", () => {
    const r = reconcile([exp("a"), exp("b"), exp("c")], []);
    expect(r.verdict).toBe("ambiguous");
    expect(r.degraded).toBe(true);
    expect(r.missing).toHaveLength(3);
    expect(r.notes.join(" ")).toMatch(/never proved readable/i);
  });

  it("defaults to unproved when no option is passed, rather than assuming trust", () => {
    expect(reconcile([exp("a")], []).verdict).toBe("ambiguous");
    expect(reconcile([exp("a")], [], { ledgerVerified: false }).verdict).toBe("ambiguous");
  });

  it("still passes when everything arrived, since nothing is then unproven", () => {
    const r = reconcile([exp("a")], [arr("a", T + 50)]);
    expect(r.verdict).toBe("pass");
  });

  it("still fails an empty expectation set, which proves nothing either way", () => {
    expect(reconcile([], []).verdict).toBe("fail");
  });
});

// L2 (audit 2026-10-25): the receiver's endpoint is public, so when it verifies
// signatures an unverified row with an expected event id is anyone's POST.
describe("reconcile when the receiver verifies signatures", () => {
  const forged = (id: string, at: number, verified: boolean | null = false): Arrival => ({
    ...arr(id, at),
    verified,
  });
  const strict = (e: readonly Expectation[], a: readonly Arrival[]) =>
    reconcile(e, a, { ledgerVerified: true, verifiedOnly: true });

  it("does not count a forged row as the expected event arriving", () => {
    const r = strict([exp("a")], [forged("a", T + 10)]);
    expect(r.verdict).toBe("fail");
    expect(r.matched).toEqual([]);
    expect(r.missing.map((m) => m.eventId)).toEqual(["a"]);
    expect(r.notes.join(" ")).toMatch(/1 unverified arrival\(s\) not counted/);
  });

  it("does not let a forged copy set the latency or count as a redelivery", () => {
    const r = strict([exp("a")], [forged("a", T + 1), arr("a", T + 900), forged("a", T + 950, null)]);
    expect(r.verdict).toBe("pass");
    expect(r.matched).toEqual([expect.objectContaining({ eventId: "a", latencyMs: 900, verified: true, duplicates: 0 })]);
    expect(r.duplicateCount).toBe(0);
  });

  it("does not list forged rows as unexpected arrivals", () => {
    expect(strict([exp("a")], [arr("a", T + 5), forged("junk", T + 6)]).unexpected).toEqual([]);
  });

  it("without the option, behaves as before for a receiver that cannot verify", () => {
    const r = rec([exp("a")], [forged("a", T + 10, null)]);
    expect(r.verdict).toBe("pass");
    expect(r.matched[0]!.verified).toBeNull();
  });
});

describe("receiverVerifies reads the self-test row", () => {
  it("is true when the receiver marked our unsigned probe false", () => {
    expect(receiverVerifies({ verified: false })).toBe(true);
  });
  it("is false when it recorded verified null, or when there is no row", () => {
    expect(receiverVerifies({ verified: null })).toBe(false);
    expect(receiverVerifies(undefined)).toBe(false);
  });
});

describe("arrivalsOf counts a resend under the same rule", () => {
  const rows = [
    { eventId: "a", verified: true },
    { eventId: "a", verified: false },
    { eventId: "a", verified: null },
    { eventId: "b", verified: true },
  ];
  it("counts verified rows only when the receiver verifies", () => {
    expect(arrivalsOf(rows, "a", true)).toHaveLength(1);
  });
  it("counts every row for the id when it does not", () => {
    expect(arrivalsOf(rows, "a", false)).toHaveLength(3);
  });
});
