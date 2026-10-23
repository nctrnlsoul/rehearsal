import { describe, expect, it } from "vitest";
import type { Db, StoreRow } from "../lib/db";
import {
  DEDUPE_BY_EVENT_ID,
  actionFor,
  handleEvent,
  readEvent,
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
      return inserted.some((r) => r.eventId === eventId);
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

  it("defaults to the setting the app ships with, so the route follows it", async () => {
    const { db } = fakeDb();
    const event = captureEvent("WH-DEFAULT");
    await handleEvent(db, event, { verified: true });
    const second = await handleEvent(db, event, { verified: true });
    expect(second).toBe(DEDUPE_BY_EVENT_ID ? "duplicate_ignored" : "fulfilled");
  });
});

describe("signature enforcement", () => {
  // The webhook endpoint is public, so without this anyone could post a forged
  // capture event and have an order fulfilled for free. This is NOT the planted
  // bug; the planted bug is the missing dedupe.
  it("never fulfils an event whose signature failed", async () => {
    const { db, inserted } = fakeDb();
    const action = await handleEvent(db, captureEvent("WH-FORGED"), { verified: false });
    expect(action).toBe("ignored");
    expect(inserted[0]!.action).toBe("ignored");
    expect(summarise(inserted.map((r) => ({ ...r, receivedAtMs: 0 }))).orders[0]!.fulfilmentCount).toBe(0);
  });

  it("never fulfils when it could not check at all", async () => {
    const { db, inserted } = fakeDb();
    expect(await handleEvent(db, captureEvent("WH-UNCHECKED"), { verified: null })).toBe("ignored");
    expect(inserted[0]!.action).toBe("ignored");
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

describe("summarise", () => {
  const row = (over: Partial<StoreRow>): StoreRow => ({
    eventId: "WH-1",
    eventType: "PAYMENT.CAPTURE.COMPLETED",
    captureId: "CAP-1",
    amount: "54.00",
    currency: "USD",
    action: "fulfilled",
    verified: true,
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

  it("counts events whose signature failed, not those never checked", () => {
    const state = summarise([row({ verified: false }), row({ verified: null }), row({})]);
    expect(state.unverifiedCount).toBe(1);
  });
});
