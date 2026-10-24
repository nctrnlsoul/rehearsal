import { describe, expect, it } from "vitest";
import type { Db, StoreRow } from "../lib/db";
import {
  DEDUPE_BY_EVENT_ID,
  MAX_REASON_CHARS,
  actionFor,
  certHostOf,
  cleanReason,
  handleEvent,
  readEvent,
  recordRefusal,
  summarise,
} from "../lib/merchant";

const captureEvent = (eventId: string, captureId = "CAP-1", amount = "54.00") => ({
  id: eventId,
  event_type: "PAYMENT.CAPTURE.COMPLETED",
  resource: { id: captureId, amount: { currency_code: "USD", value: amount } },
});

function fakeDb() {
  const inserted: Array<Omit<StoreRow, "receivedAtMs">> = [];
  const db: Db = {
    async hasEvent(eventId) {
      // Mirrors the real lookup: only a verified, non-refused row counts as seen.
      return inserted.some(
        (r) => r.eventId === eventId && r.verified === true && r.action !== "refused",
      );
    },
    async insert(row) {
      inserted.push(row);
    },
    async rows() {
      return [];
    },
  };
  return { db, inserted };
}

describe("readEvent", () => {
  it("reads a capture event", () => {
    expect(readEvent(captureEvent("WH-1"))).toEqual({
      eventId: "WH-1",
      eventType: "PAYMENT.CAPTURE.COMPLETED",
      captureId: "CAP-1",
      amount: "54.00",
      currency: "USD",
    });
  });

  it("reads a dispute event, whose order id lives in disputed_transactions", () => {
    const parsed = readEvent({
      id: "WH-D",
      event_type: "CUSTOMER.DISPUTE.CREATED",
      resource: {
        dispute_amount: { currency_code: "USD", value: "88.00" },
        disputed_transactions: [{ seller_transaction_id: "CAP-9" }],
      },
    });
    expect(parsed.captureId).toBe("CAP-9");
    expect(parsed.amount).toBe("88.00");
  });

  it("survives junk without throwing", () => {
    for (const junk of [null, undefined, "nope", 7, {}, { resource: "x" }, []]) {
      const parsed = readEvent(junk);
      expect(parsed.eventType).toBe("UNKNOWN");
      expect(parsed.captureId).toBeNull();
    }
  });
});

describe("actionFor", () => {
  it("maps the events this shop cares about and ignores the rest", () => {
    expect(actionFor("PAYMENT.CAPTURE.COMPLETED")).toBe("fulfilled");
    expect(actionFor("PAYMENT.CAPTURE.REFUNDED")).toBe("refund_recorded");
    expect(actionFor("CUSTOMER.DISPUTE.CREATED")).toBe("dispute_noted");
    expect(actionFor("PAYMENT.PAYOUTSBATCH.SUCCESS")).toBe("ignored");
    expect(actionFor("ANYTHING.ELSE")).toBe("ignored");
  });
});

describe("the planted bug", () => {
  /**
   * This is the bug the edge-case finder exists to catch. PayPal redelivers,
   * and an event can be resent on demand, so the event id is an idempotency
   * key. Without deduping, the same capture is fulfilled twice.
   */
  it("fulfils the same order twice when a capture event is delivered twice", async () => {
    const { db, inserted } = fakeDb();
    const event = captureEvent("WH-DUP");

    await handleEvent(db, event, { verified: true, dedupe: false });
    await handleEvent(db, event, { verified: true, dedupe: false });

    expect(inserted).toHaveLength(2);
    expect(inserted.every((r) => r.action === "fulfilled")).toBe(true);
    expect(summarise(inserted.map((r) => ({ ...r, receivedAtMs: 0 }))).orders[0]).toMatchObject({
      captureId: "CAP-1",
      fulfilmentCount: 2,
    });
  });

  /** The one-line fix: DEDUPE_BY_EVENT_ID = true. */
  it("fulfils once when deduping is on, and records the duplicate as handled", async () => {
    const { db, inserted } = fakeDb();
    const event = captureEvent("WH-DUP");

    await handleEvent(db, event, { verified: true, dedupe: true });
    const second = await handleEvent(db, event, { verified: true, dedupe: true });

    expect(second).toBe("duplicate_ignored");
    const state = summarise(inserted.map((r) => ({ ...r, receivedAtMs: 0 })));
    expect(state.orders[0]).toMatchObject({
      captureId: "CAP-1",
      fulfilmentCount: 1,
      duplicatesIgnored: 1,
    });
  });

  it("still fulfils two genuinely different orders", async () => {
    const { db, inserted } = fakeDb();
    await handleEvent(db, captureEvent("WH-A", "CAP-A"), { verified: true, dedupe: true });
    await handleEvent(db, captureEvent("WH-B", "CAP-B"), { verified: true, dedupe: true });
    const state = summarise(inserted.map((r) => ({ ...r, receivedAtMs: 0 })));
    expect(state.orders).toHaveLength(2);
    expect(state.orders.every((o) => o.fulfilmentCount === 1)).toBe(true);
  });

  // A refused copy must not poison the event id: PayPal retries after a
  // transient verify failure, and a forger may post a junk copy first.
  it("still fulfils a real delivery after a refused copy of the same event id", async () => {
    const { db, inserted } = fakeDb();
    const event = captureEvent("WH-POISON");
    await handleEvent(db, event, { verified: false, detail: "forged", dedupe: true });
    await handleEvent(db, event, { verified: null, detail: "verify call failed", dedupe: true });
    expect(await handleEvent(db, event, { verified: true, dedupe: true })).toBe("fulfilled");
    expect(await handleEvent(db, event, { verified: true, dedupe: true })).toBe(
      "duplicate_ignored",
    );
    expect(inserted.map((r) => r.action)).toEqual([
      "refused",
      "refused",
      "fulfilled",
      "duplicate_ignored",
    ]);
  });

  // Pinned, not conditional: a test that passes on either value of the flag
  // would not notice the fix being reverted.
  it("ships with deduping on, and the route's default follows it", async () => {
    expect(DEDUPE_BY_EVENT_ID).toBe(true);
    const { db, inserted } = fakeDb();
    const event = captureEvent("WH-DEFAULT");
    expect(await handleEvent(db, event, { verified: true })).toBe("fulfilled");
    expect(await handleEvent(db, event, { verified: true })).toBe("duplicate_ignored");
    expect(inserted.map((r) => r.action)).toEqual(["fulfilled", "duplicate_ignored"]);
  });
});

describe("signature enforcement", () => {
  // The webhook endpoint is public, so without this anyone could post a forged
  // capture event and have an order fulfilled for free. This is NOT the planted
  // bug; the planted bug is the missing dedupe.
  it("never fulfils an event whose signature failed, and records why", async () => {
    const { db, inserted } = fakeDb();
    const action = await handleEvent(db, captureEvent("WH-FORGED"), {
      verified: false,
      detail: "missing paypal-transmission-sig",
    });
    expect(action).toBe("refused");
    expect(inserted[0]!.action).toBe("refused");
    expect(inserted[0]!.reason).toBe("missing paypal-transmission-sig");
    expect(summarise(inserted.map((r) => ({ ...r, receivedAtMs: 0 }))).orders[0]!.fulfilmentCount).toBe(0);
  });

  it("never fulfils when it could not check at all, and records why", async () => {
    const { db, inserted } = fakeDb();
    expect(
      await handleEvent(db, captureEvent("WH-UNCHECKED"), {
        verified: null,
        detail: "no webhook is registered for this store's handler URL",
      }),
    ).toBe("refused");
    expect(inserted[0]!).toMatchObject({ action: "refused", verified: null });
    expect(inserted[0]!.reason).toContain("no webhook is registered");
  });

  it("still names a reason when the caller gave none", async () => {
    const { db, inserted } = fakeDb();
    await handleEvent(db, captureEvent("WH-A"), { verified: false });
    await handleEvent(db, captureEvent("WH-B"), { verified: null });
    expect(inserted.map((r) => r.reason)).toEqual(["signature did not verify", "could not verify"]);
  });

  it("keeps a reason single-line and bounded, because the endpoint is public", () => {
    expect(cleanReason("host \u001b[31mevil\nnext\u202e")).toBe("host [31mevil next");
    expect(Array.from(cleanReason("x".repeat(5000)))).toHaveLength(MAX_REASON_CHARS);
    expect(cleanReason("\u0000\u0007")).toBe("refused");
  });

  it("records a request that could not be read as an event", async () => {
    const { db, inserted } = fakeDb();
    await recordRefusal(db, "body is not JSON");
    expect(inserted).toEqual([
      {
        eventId: null,
        eventType: "UNKNOWN",
        captureId: null,
        amount: null,
        currency: null,
        action: "refused",
        verified: null,
        reason: "body is not JSON",
        certHost: null,
      },
    ]);
  });

  it("records the cert host on a refusal and on an acted-on event alike", async () => {
    const { db, inserted } = fakeDb();
    await recordRefusal(db, "body is not JSON", "api.sandbox.paypal.com");
    await handleEvent(db, captureEvent("WH-BAD"), {
      verified: false,
      detail: "paypal-cert-url host certs.evil.test is not paypal.com",
      certHost: "certs.evil.test",
    });
    await handleEvent(db, captureEvent("WH-GOOD"), { verified: true, certHost: "api.sandbox.paypal.com" });
    expect(inserted.map((r) => [r.action, r.certHost])).toEqual([
      ["refused", "api.sandbox.paypal.com"],
      ["refused", "certs.evil.test"],
      ["fulfilled", "api.sandbox.paypal.com"],
    ]);
  });

  it("records no cert host when the caller had none", async () => {
    const { db, inserted } = fakeDb();
    await handleEvent(db, captureEvent("WH-1"), { verified: true });
    expect(inserted[0]!.certHost).toBeNull();
  });

  // "ignored" now means only: verified, but of no use to the shop.
  it("still ignores, without a reason, a verified event of a type it does not handle", async () => {
    const { db, inserted } = fakeDb();
    const action = await handleEvent(
      db,
      { id: "WH-X", event_type: "BILLING.PLAN.CREATED", resource: {} },
      { verified: true },
    );
    expect(action).toBe("ignored");
    expect(inserted[0]!.reason).toBeNull();
  });

  it("records the attempt so an ignored event is still visible", async () => {
    const { db, inserted } = fakeDb();
    await handleEvent(db, captureEvent("WH-FORGED"), { verified: false });
    expect(inserted).toHaveLength(1);
    expect(inserted[0]!.verified).toBe(false);
    expect(inserted[0]!.eventId).toBe("WH-FORGED");
  });

  it("acts only on a verified event", async () => {
    const { db } = fakeDb();
    expect(await handleEvent(db, captureEvent("WH-REAL"), { verified: true })).toBe("fulfilled");
  });
});

describe("certHostOf", () => {
  it("takes the lower-cased host of a parseable URL", () => {
    expect(certHostOf("https://API.Sandbox.PayPal.com/v1/notifications/certs/C")).toBe(
      "api.sandbox.paypal.com",
    );
    expect(certHostOf("https://certs.evil.test:8443/x")).toBe("certs.evil.test");
  });

  it("records nothing for an absent, blank, unparseable or absurd value", () => {
    expect(certHostOf(null)).toBeNull();
    expect(certHostOf("  ")).toBeNull();
    expect(certHostOf("not a url")).toBeNull();
    const label = "a".repeat(60);
    const tooLong = `${label}.${label}.${label}.${label}.${label}.test`;
    expect(tooLong.length).toBeGreaterThan(253);
    expect(certHostOf(`https://${tooLong}/`)).toBeNull();
  });
});

describe("summarise", () => {
  const row = (over: Partial<StoreRow>): StoreRow => ({
    eventId: "WH-1",
    eventType: "PAYMENT.CAPTURE.COMPLETED",
    captureId: "CAP-1",
    amount: "54.00",
    currency: "USD",
    action: "fulfilled",
    verified: true,
    reason: null,
    certHost: null,
    receivedAtMs: 0,
    ...over,
  });

  it("groups by capture and counts each action", () => {
    const state = summarise([
      row({}),
      row({ action: "refund_recorded" }),
      row({ action: "dispute_noted" }),
      row({ captureId: "CAP-2" }),
    ]);
    expect(state.orders).toHaveLength(2);
    const first = state.orders.find((o) => o.captureId === "CAP-1")!;
    expect(first).toMatchObject({ fulfilmentCount: 1, refundCount: 1, disputeCount: 1 });
    expect(state.eventCount).toBe(4);
  });

  it("skips rows with no order to attribute them to", () => {
    expect(summarise([row({ captureId: null })]).orders).toHaveLength(0);
  });

  it("reports each event id's deliveries, so a resend is visible as the same event twice", () => {
    const state = summarise([
      row({ eventId: "WH-1" }),
      row({ eventId: "WH-1" }),
      row({ eventId: "WH-2", captureId: "CAP-2" }),
      row({ eventId: "WH-2", captureId: "CAP-2", action: "duplicate_ignored" }),
      row({ eventId: "WH-3", action: "refused", verified: false, reason: "bad sig" }),
      row({ eventId: "WH-3", action: "refused", verified: false, reason: "bad sig" }),
      row({ eventId: "WH-3", action: "refused", verified: null, reason: "no webhook" }),
      row({ eventId: null }),
    ]);
    const none = { refused: 0, refusalReasons: [], certHosts: [] };
    expect(state.deliveries).toEqual([
      { eventId: "WH-1", eventType: "PAYMENT.CAPTURE.COMPLETED", fulfilled: 2, duplicatesIgnored: 0, other: 0, ...none },
      { eventId: "WH-2", eventType: "PAYMENT.CAPTURE.COMPLETED", fulfilled: 1, duplicatesIgnored: 1, other: 0, ...none },
      {
        eventId: "WH-3",
        eventType: "PAYMENT.CAPTURE.COMPLETED",
        fulfilled: 0,
        duplicatesIgnored: 0,
        other: 3,
        refused: 3,
        refusalReasons: ["bad sig", "no webhook"],
        certHosts: [],
      },
    ]);
  });

  // The question this answers: does a resend name the same cert host as the original?
  it("lists the distinct cert hosts each event's deliveries named", () => {
    const state = summarise([
      row({ eventId: "WH-SAME", certHost: "api.sandbox.paypal.com" }),
      row({ eventId: "WH-SAME", certHost: "api.sandbox.paypal.com" }),
      row({ eventId: "WH-DIFF", certHost: "api.sandbox.paypal.com" }),
      row({ eventId: "WH-DIFF", certHost: "api-m.sandbox.paypal.com" }),
      row({ eventId: "WH-DIFF", certHost: null }),
    ]);
    const hosts = Object.fromEntries(state.deliveries.map((d) => [d.eventId, d.certHosts]));
    expect(hosts).toEqual({
      "WH-SAME": ["api.sandbox.paypal.com"],
      "WH-DIFF": ["api.sandbox.paypal.com", "api-m.sandbox.paypal.com"],
    });
  });

  it("reports refusals that carry no event id separately, so they are not lost", () => {
    const state = summarise([
      row({ eventId: null, action: "refused", reason: "body is not JSON" }),
      row({ eventId: null, action: "refused", reason: "body is not JSON" }),
      row({ eventId: null, action: "refused", reason: null }),
      row({ eventId: null, action: "fulfilled" }),
    ]);
    expect(state.unattributedRefusals).toEqual({
      count: 3,
      reasons: ["body is not JSON", "no reason recorded"],
    });
  });

  it("caps the reasons it lists, however much junk arrives", () => {
    const junk = Array.from({ length: 50 }, (_, i) =>
      row({ eventId: null, action: "refused", reason: `junk ${i}` }),
    );
    const state = summarise(junk);
    expect(state.unattributedRefusals.count).toBe(50);
    expect(state.unattributedRefusals.reasons).toHaveLength(5);
  });

  it("counts events whose signature failed, not those never checked", () => {
    const state = summarise([row({ verified: false }), row({ verified: null }), row({})]);
    expect(state.unverifiedCount).toBe(1);
  });
});
