import { describe, expect, it } from "vitest";
import {
  type Bank,
  addPurchase,
  attachTransactionId,
  availablePurchases,
  claimPurchase,
  confirmCapture,
  MOVED_TO_HOSTED,
  emptyBank,
  exportForHosted,
  hostedInsertSql,
  markExpired,
} from "../src/core/purchaseBank";

const T = "2026-10-23T00:00:00.000Z";

const seed = (orderId: string, createdAt = T) => ({
  id: `p-${orderId}`,
  orderId,
  amount: "88.00",
  currency: "USD",
  createdAt,
  approvalUrl: `https://www.sandbox.paypal.com/checkoutnow?token=${orderId}`,
});

/** Walks one purchase all the way to drawable. */
function ready(bank: Bank, orderId: string, createdAt = T): Bank {
  const a = addPurchase(bank, seed(orderId, createdAt));
  if (!a.ok) throw new Error(a.error);
  const c = confirmCapture(a.value, orderId, `CAP-${orderId}`);
  if (!c.ok) throw new Error(c.error);
  const t = attachTransactionId(c.value, orderId, `TXN-${orderId}`);
  if (!t.ok) throw new Error(t.error);
  return t.value;
}

describe("the bank lifecycle", () => {
  it("walks a purchase from created to drawable", () => {
    const a = addPurchase(emptyBank(), seed("O1"));
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    expect(a.value.purchases[0]!.status).toBe("awaiting_approval");
    expect(availablePurchases(a.value)).toHaveLength(0);

    const c = confirmCapture(a.value, "O1", "CAP-1");
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    expect(c.value.purchases[0]!.status).toBe("awaiting_transaction_id");
    expect(availablePurchases(c.value)).toHaveLength(0);

    const t = attachTransactionId(c.value, "O1", "TXN-1");
    expect(t.ok).toBe(true);
    if (!t.ok) return;
    expect(t.value.purchases[0]!.status).toBe("available");
    expect(availablePurchases(t.value)).toHaveLength(1);
  });

  it("refuses a duplicate order", () => {
    const first = addPurchase(emptyBank(), seed("O1"));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const again = addPurchase(first.value, seed("O1"));
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error).toContain("already in the bank");
  });

  it("refuses transitions out of order", () => {
    const a = addPurchase(emptyBank(), seed("O1"));
    if (!a.ok) return;
    // Cannot attach a transaction id before the capture exists.
    const early = attachTransactionId(a.value, "O1", "TXN-1");
    expect(early.ok).toBe(false);
    if (!early.ok) expect(early.error).toMatch(/not waiting for a transaction id/i);

    const done = ready(emptyBank(), "O2");
    const twice = confirmCapture(done, "O2", "CAP-again");
    expect(twice.ok).toBe(false);
    if (!twice.ok) expect(twice.error).toMatch(/not waiting to be captured/i);
  });

  it("refuses to touch an order it does not hold, and refuses blank ids", () => {
    expect(confirmCapture(emptyBank(), "nope", "C").ok).toBe(false);
    expect(attachTransactionId(emptyBank(), "nope", "T").ok).toBe(false);
    const a = addPurchase(emptyBank(), seed("O1"));
    if (!a.ok) return;
    expect(confirmCapture(a.value, "O1", "   ").ok).toBe(false);
  });
});

describe("markExpired", () => {
  // The real case: an approval link left overnight, then GET order returns 404.
  it("marks an unapproved order expired with its evidence", () => {
    const a = addPurchase(emptyBank(), seed("O1"));
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    const e = markExpired(a.value, "O1", "PayPal returned 404 on the order");
    expect(e.ok).toBe(true);
    if (!e.ok) return;
    expect(e.value.purchases[0]!.status).toBe("expired");
    expect(e.value.purchases[0]!.expiredReason).toContain("404");
    expect(availablePurchases(e.value)).toHaveLength(0);
  });

  it("refuses to expire a purchase whose money already moved", () => {
    const captured = ready(emptyBank(), "O1");
    const e = markExpired(captured, "O1", "404");
    expect(e.ok).toBe(false);
    if (!e.ok) expect(e.error).toMatch(/cannot expire/i);
  });

  it("refuses an unknown order and a blank reason", () => {
    expect(markExpired(emptyBank(), "nope", "404").ok).toBe(false);
    const a = addPurchase(emptyBank(), seed("O1"));
    if (!a.ok) return;
    expect(markExpired(a.value, "O1", "   ").ok).toBe(false);
  });

  it("is never drawable, so a dispute step cannot pick it up", () => {
    const a = addPurchase(emptyBank(), seed("O1"));
    if (!a.ok) return;
    const e = markExpired(a.value, "O1", "404");
    if (!e.ok) return;
    const claim = claimPurchase(e.value, "run-1", T);
    expect(claim.ok).toBe(false);
    if (!claim.ok) {
      expect(claim.error).toMatch(/1 expired unapproved/);
      expect(claim.error).toMatch(/bank:add/);
    }
  });
});

describe("claimPurchase", () => {
  it("takes the oldest drawable purchase and marks it used", () => {
    let bank = ready(emptyBank(), "NEW", "2026-10-23T05:00:00.000Z");
    bank = ready(bank, "OLD", "2026-10-22T05:00:00.000Z");

    const r = claimPurchase(bank, "run-7", T);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.claimed.orderId).toBe("OLD");
    const used = r.value.bank.purchases.find((p) => p.orderId === "OLD")!;
    expect(used.status).toBe("used");
    expect(used.usedByRunId).toBe("run-7");
    expect(used.usedAt).toBe(T);
  });

  it("never hands out the same purchase twice", () => {
    const bank = ready(emptyBank(), "O1");
    const first = claimPurchase(bank, "run-1", T);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = claimPurchase(first.value.bank, "run-2", T);
    expect(second.ok).toBe(false);
  });

  // Fail closed: no purchase means the dispute step stops, never silently skips.
  it("errors with a usable message when nothing is drawable", () => {
    const empty = claimPurchase(emptyBank(), "run-1", T);
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.error).toMatch(/bank is empty/i);

    const a = addPurchase(emptyBank(), seed("O1"));
    if (!a.ok) return;
    const pending = claimPurchase(a.value, "run-1", T);
    expect(pending.ok).toBe(false);
    if (!pending.ok) expect(pending.error).toMatch(/awaiting approval/i);
    if (!pending.ok) expect(pending.error).not.toMatch(/expired/i);
  });

  it("refuses a purchase whose status lies about carrying both ids", () => {
    // Simulates a hand-edited or truncated bank file.
    const corrupt: Bank = {
      version: 1,
      purchases: [
        {
          ...seed("O1"),
          captureId: "CAP-1",
          buyerTransactionId: null,
          status: "available",
          usedByRunId: null,
          usedAt: null,
        },
      ],
    };
    expect(availablePurchases(corrupt)).toHaveLength(0);
    expect(claimPurchase(corrupt, "run-1", T).ok).toBe(false);
  });
});

describe("exportForHosted and hostedInsertSql (Stage B bank move)", () => {
  const ready = (orderId: string, createdAt: string) =>
    ({
      id: orderId,
      orderId,
      captureId: `CAP-${orderId}`,
      buyerTransactionId: `TXN-${orderId}`,
      amount: "25.00",
      currency: "USD",
      status: "available",
      createdAt,
      approvalUrl: null,
      usedByRunId: null,
      usedAt: null,
    }) as const;
  const bank = () => ({
    version: 1 as const,
    purchases: [ready("O-NEW", "2026-10-25T10:00:00Z"), ready("O-OLD", "2026-10-24T10:00:00Z"), { ...ready("O-WAIT", "2026-10-23T10:00:00Z"), status: "awaiting_approval" as const, captureId: null, buyerTransactionId: null }],
  });

  it("moves the oldest ready purchases and marks them used locally, so the local bank can never draw them", () => {
    const r = exportForHosted(bank(), 1, "2026-10-25T12:00:00Z");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.moved.map((p) => p.orderId)).toEqual(["O-OLD"]);
    const old = r.value.bank.purchases.find((p) => p.orderId === "O-OLD")!;
    expect(old).toMatchObject({ status: "used", usedByRunId: MOVED_TO_HOSTED, usedAt: "2026-10-25T12:00:00Z" });
    expect(availablePurchases(r.value.bank).map((p) => p.orderId)).toEqual(["O-NEW"]);
  });

  it("never moves a purchase that is not ready, and refuses when none is", () => {
    const r = exportForHosted(bank(), 10, "2026-10-25T12:00:00Z");
    expect(r.ok && r.value.moved.map((p) => p.orderId)).toEqual(["O-OLD", "O-NEW"]);
    const empty = exportForHosted({ version: 1, purchases: [] }, 1, "2026-10-25T12:00:00Z");
    expect(empty.ok).toBe(false);
    expect(exportForHosted(bank(), 0, "2026-10-25T12:00:00Z").ok).toBe(false);
  });

  it("writes an insert that skips orders already moved", () => {
    const r = exportForHosted(bank(), 2, "2026-10-25T12:00:00Z");
    if (!r.ok) throw new Error(r.error);
    const sql = hostedInsertSql(r.value.moved, "2026-10-25T12:00:00Z");
    expect(sql.ok).toBe(true);
    if (!sql.ok) return;
    expect(sql.value).toContain("insert into public.console_purchases");
    expect(sql.value).toContain("('O-OLD', 'CAP-O-OLD', 'TXN-O-OLD', '25.00', 'USD', '2026-10-24T10:00:00.000Z'::timestamptz)");
    expect(sql.value).toContain("on conflict (order_id) do nothing;");
    expect(sql.value).toContain("CONSOLE's own Supabase project");
  });

  it("refuses any id that is not plain letters, digits and dashes, so nothing can reach the SQL", () => {
    for (const bad of ["O'1", "O-1); drop table x; --", "O 1", "", "x".repeat(129)]) {
      const p = { ...ready("O-1", "2026-10-24T10:00:00Z"), orderId: bad };
      expect(hostedInsertSql([p], "now").ok, bad).toBe(false);
    }
    expect(hostedInsertSql([{ ...ready("O-1", "2026-10-24T10:00:00Z"), buyerTransactionId: "T'1" }], "now").ok).toBe(false);
    expect(hostedInsertSql([{ ...ready("O-1", "2026-10-24T10:00:00Z"), amount: "1e3" }], "now").ok).toBe(false);
    expect(hostedInsertSql([{ ...ready("O-1", "2026-10-24T10:00:00Z"), createdAt: "not a time" }], "now").ok).toBe(false);
  });

});
