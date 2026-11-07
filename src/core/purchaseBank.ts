/**
 * The purchase bank: approved buyer purchases a dispute scenario can draw from.
 *
 * A PayPal-wallet purchase needs a human approval click, and the buyer-side
 * transaction id has to be looked up afterwards. Neither can happen inside a
 * scenario run, so purchases are banked ahead of time and consumed one per
 * dispute. Pure: all transitions here, all file I/O in the adapter.
 */

import type { Caps } from "./caps";
import { fromMinor, toMinor } from "./money";

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

/**
 * The per-step cap, applied to a banked purchase before its order exists, so
 * "every write keyed and capped" holds for bank:add too. The amount must also
 * be a plain amount in the caps' currency.
 */
export function checkPurchaseAmount(amount: string, currency: string, caps: Caps): BankResult<bigint> {
  if (currency !== caps.currency) {
    return { ok: false, error: `a banked purchase must be in ${caps.currency}, the caps' currency, not ${currency}` };
  }
  let minor: bigint;
  try {
    minor = toMinor(amount, currency);
  } catch {
    return { ok: false, error: `amount ${JSON.stringify(amount)} is not a plain amount in ${currency}` };
  }
  if (minor <= 0n) return { ok: false, error: "a banked purchase needs an amount above zero" };
  if (minor > caps.maxStepAmountMinor) {
    return {
      ok: false,
      error: `purchase of ${currency} ${fromMinor(minor, currency)} is over the per-step cap of ${currency} ${fromMinor(caps.maxStepAmountMinor, currency)}`,
    };
  }
  return { ok: true, value: minor };
}

/** How far before the order a buyer transaction may be stamped and still be its payment: clock skew only. */
const MATCH_SKEW_MS = 5 * 60 * 1000;

/**
 * The buyer-side transaction that paid for a banked purchase, from rows of
 * PayPal's Transaction Search. A match needs the same amount (as money, either
 * sign) and the same currency, no earlier than the order was created; of those,
 * the one closest in time wins. Amount alone matched another purchase of the
 * same price, and a dispute against the wrong transaction tests nothing.
 */
export function matchBuyerTransaction(
  purchase: Purchase,
  rows: readonly unknown[],
  taken: ReadonlySet<string>,
): { readonly id: string | null; readonly candidates: number } {
  const createdMs = Date.parse(purchase.createdAt);
  const want = toMinor(purchase.amount, purchase.currency);
  const field = (o: unknown, ...path: string[]): string | null => {
    let cur: unknown = o;
    for (const k of path) {
      if (typeof cur !== "object" || cur === null) return null;
      cur = (cur as Record<string, unknown>)[k];
    }
    return typeof cur === "string" && cur.trim() !== "" ? cur : null;
  };
  const candidates = rows
    .map((r) => (typeof r === "object" && r !== null ? (r as Record<string, unknown>)["transaction_info"] : null))
    .map((info) => {
      const value = field(info, "transaction_amount", "value");
      let minor: bigint | null = null;
      try {
        minor = value === null ? null : toMinor(value.replace(/^-/, ""), purchase.currency);
      } catch {
        minor = null;
      }
      return {
        id: field(info, "transaction_id"),
        minor,
        currency: field(info, "transaction_amount", "currency_code"),
        atMs: Date.parse(field(info, "transaction_initiation_date") ?? ""),
      };
    })
    .filter(
      (c): c is { id: string; minor: bigint; currency: string; atMs: number } =>
        c.id !== null &&
        !taken.has(c.id) &&
        c.minor === want &&
        c.currency === purchase.currency &&
        !Number.isNaN(c.atMs) &&
        (Number.isNaN(createdMs) || c.atMs >= createdMs - MATCH_SKEW_MS),
    )
    .sort((a, b) => Math.abs(a.atMs - createdMs) - Math.abs(b.atMs - createdMs));
  return { id: candidates[0]?.id ?? null, candidates: candidates.length };
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

/** What a moved purchase is marked used by in the local bank. */
export const MOVED_TO_HOSTED = "moved-to-hosted";

/**
 * Moves up to `count` drawable purchases out of the local bank, oldest first,
 * for the hosted console's bank. Each is marked used HERE, before anything is
 * written for the console: a move that never reaches the console burns a
 * purchase (one human click), while a purchase in both banks could be
 * disputed twice.
 */
export function exportForHosted(
  bank: Bank,
  count: number,
  nowIso: string,
): BankResult<{ bank: Bank; moved: Purchase[] }> {
  if (!Number.isInteger(count) || count < 1) return { ok: false, error: "count must be a whole number of at least 1" };
  const drawable = [...availablePurchases(bank)].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  if (drawable.length === 0) return { ok: false, error: "no purchase is ready to move: none is available with both ids" };
  const moved = drawable.slice(0, count);
  let next = bank;
  for (const p of moved) next = replace(next, p.orderId, { status: "used", usedByRunId: MOVED_TO_HOSTED, usedAt: nowIso });
  return { ok: true, value: { bank: next, moved } };
}

const SQL_ID = /^[A-Za-z0-9-]{1,128}$/;
const SQL_AMOUNT = /^[0-9]{1,10}(\.[0-9]{1,2})?$/;
const SQL_CURRENCY = /^[A-Z]{3}$/;

/**
 * The SQL that adds moved purchases to the console's bank. Generated text, so
 * every value is checked against a strict shape first and anything else is
 * refused, rather than escaped: an id is never a place for a quote.
 */
export function hostedInsertSql(moved: readonly Purchase[], nowIso: string): BankResult<string> {
  const rows: string[] = [];
  for (const p of moved) {
    const values = [p.orderId, p.captureId ?? "", p.buyerTransactionId ?? ""];
    if (!values.every((v) => SQL_ID.test(v))) return { ok: false, error: `order ${p.orderId.slice(0, 40)} has an id that is not plain letters, digits and dashes` };
    if (!SQL_AMOUNT.test(p.amount) || !SQL_CURRENCY.test(p.currency)) return { ok: false, error: `order ${p.orderId} has an amount or currency of an unexpected shape` };
    if (Number.isNaN(Date.parse(p.createdAt))) return { ok: false, error: `order ${p.orderId} has an unreadable creation time` };
    rows.push(`  ('${values[0]}', '${values[1]}', '${values[2]}', '${p.amount}', '${p.currency}', '${new Date(p.createdAt).toISOString()}'::timestamptz)`);
  }
  if (rows.length === 0) return { ok: false, error: "nothing to write" };
  return {
    ok: true,
    value: [
      `-- Generated by rehearsal bank:export-hosted at ${nowIso}.`,
      "-- Run in the SQL editor of the CONSOLE's own Supabase project (R-040), never the store's.",
      "-- Safe to run twice: an order already in the console's bank is skipped.",
      "-- These purchases are already marked used in the local bank, so only the console can draw them.",
      "insert into public.console_purchases (order_id, capture_id, buyer_transaction_id, amount, currency, created_at)",
      "values",
      `${rows.join(",\n")}`,
      "on conflict (order_id) do nothing;",
      "",
      "select available, used from public.console_bank_counts();",
      "",
    ].join("\n"),
  };
}
