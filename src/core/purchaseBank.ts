/**
 * The purchase bank: approved buyer purchases a dispute scenario can draw from.
 *
 * A PayPal-wallet purchase needs a human approval click, and the buyer-side
 * transaction id has to be looked up afterwards. Neither can happen inside a
 * scenario run, so purchases are banked ahead of time and consumed one per
 * dispute. Pure: all transitions here, all file I/O in the adapter.
 */

export type PurchaseStatus =
  /** Order created, waiting for the human to approve it in a browser. */
  | "awaiting_approval"
  /** Captured, waiting for the buyer-side transaction id to become visible. */
  | "awaiting_transaction_id"
  /** Complete and unused: a dispute may draw this one. */
  | "available"
  | "used"
  /** The approval link lapsed before anyone clicked it. Never drawable. */
  | "expired";

export type Purchase = {
  readonly id: string;
  readonly orderId: string;
  readonly captureId: string | null;
  readonly buyerTransactionId: string | null;
  readonly amount: string;
  readonly currency: string;
  readonly status: PurchaseStatus;
  readonly createdAt: string;
  readonly approvalUrl: string | null;
  readonly usedByRunId: string | null;
  readonly usedAt: string | null;
  /** Why it expired, kept so the label is backed by evidence rather than a guess. */
  readonly expiredReason?: string;
};

export type Bank = {
  readonly version: 1;
  readonly purchases: Purchase[];
};

export type BankResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };

export function emptyBank(): Bank {
  return { version: 1, purchases: [] };
}

export function availablePurchases(bank: Bank): Purchase[] {
  return bank.purchases.filter(isDrawable);
}

/**
 * Defence in depth against a hand-edited or truncated bank file: a purchase is
 * only drawable if it actually carries both ids, whatever its status says.
 */
function isDrawable(p: Purchase): boolean {
  return (
    p.status === "available" &&
    p.captureId !== null &&
    p.captureId.trim() !== "" &&
    p.buyerTransactionId !== null &&
    p.buyerTransactionId.trim() !== ""
  );
}

export function addPurchase(
  bank: Bank,
  purchase: Omit<Purchase, "status" | "usedByRunId" | "usedAt" | "captureId" | "buyerTransactionId">,
): BankResult<Bank> {
  if (bank.purchases.some((p) => p.orderId === purchase.orderId)) {
    return { ok: false, error: `order ${purchase.orderId} is already in the bank` };
  }
  const added: Purchase = {
    ...purchase,
    captureId: null,
    buyerTransactionId: null,
    status: "awaiting_approval",
    usedByRunId: null,
    usedAt: null,
  };
  return { ok: true, value: { ...bank, purchases: [...bank.purchases, added] } };
}

function replace(bank: Bank, orderId: string, patch: Partial<Purchase>): Bank {
  return {
    ...bank,
    purchases: bank.purchases.map((p) => (p.orderId === orderId ? { ...p, ...patch } : p)),
  };
}

export function confirmCapture(
  bank: Bank,
  orderId: string,
  captureId: string,
): BankResult<Bank> {
  const found = bank.purchases.find((p) => p.orderId === orderId);
  if (found === undefined) return { ok: false, error: `order ${orderId} is not in the bank` };
  if (found.status !== "awaiting_approval") {
    return {
      ok: false,
      error: `order ${orderId} is ${found.status}, so it is not waiting to be captured`,
    };
  }
  if (captureId.trim() === "") return { ok: false, error: "captureId must not be blank" };
  return {
    ok: true,
    value: replace(bank, orderId, { captureId, status: "awaiting_transaction_id" }),
  };
}

export function attachTransactionId(
  bank: Bank,
  orderId: string,
  buyerTransactionId: string,
): BankResult<Bank> {
  const found = bank.purchases.find((p) => p.orderId === orderId);
  if (found === undefined) return { ok: false, error: `order ${orderId} is not in the bank` };
  if (found.status !== "awaiting_transaction_id") {
    return {
      ok: false,
      error: `order ${orderId} is ${found.status}, so it is not waiting for a transaction id`,
    };
  }
  if (buyerTransactionId.trim() === "") {
    return { ok: false, error: "buyerTransactionId must not be blank" };
  }
  return { ok: true, value: replace(bank, orderId, { buyerTransactionId, status: "available" }) };
}

/**
 * Marks an unapproved order dead so nothing waits on it again.
 *
 * Only an order still awaiting approval can expire. Once captured, money has
 * moved and the purchase is real whatever the approval link does.
 */
export function markExpired(bank: Bank, orderId: string, reason: string): BankResult<Bank> {
  const found = bank.purchases.find((p) => p.orderId === orderId);
  if (found === undefined) return { ok: false, error: `order ${orderId} is not in the bank` };
  if (found.status !== "awaiting_approval") {
    return {
      ok: false,
      error: `order ${orderId} is ${found.status}, so it cannot expire`,
    };
  }
  if (reason.trim() === "") return { ok: false, error: "an expiry needs a reason" };
  return { ok: true, value: replace(bank, orderId, { status: "expired", expiredReason: reason }) };
}

/** Takes the oldest drawable purchase and marks it used. Never reuses one. */
export function claimPurchase(
  bank: Bank,
  runId: string,
  nowIso: string,
): BankResult<{ bank: Bank; claimed: Purchase }> {
  const drawable = availablePurchases(bank);
  if (drawable.length === 0) {
    const waiting = bank.purchases.filter(
      (p) => p.status === "awaiting_approval" || p.status === "awaiting_transaction_id",
    ).length;
    const expired = bank.purchases.filter((p) => p.status === "expired").length;
    const parts: string[] = [];
    if (waiting > 0) parts.push(`${waiting} still awaiting approval or a transaction id`);
    if (expired > 0) parts.push(`${expired} expired unapproved`);
    return {
      ok: false,
      error:
        parts.length > 0
          ? `no purchase is ready to dispute: ${parts.join(", ")}. Run bank:add for a fresh one and approve it promptly.`
          : "the purchase bank is empty, so no dispute can be opened. Add a purchase first.",
    };
  }
  const oldest = [...drawable].sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0]!;
  return {
    ok: true,
    value: {
      bank: replace(bank, oldest.orderId, { status: "used", usedByRunId: runId, usedAt: nowIso }),
      claimed: oldest,
    },
  };
}
