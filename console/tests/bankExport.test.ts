import { describe, expect, it } from "vitest";
import { exportForHosted, hostedInsertSql } from "../lib/engine";
import { freshDb } from "./pg";

/** The SQL that bank:export-hosted writes, run against the console's committed migrations. */
describe("the hosted bank export", () => {
  const ready = (orderId: string, createdAt: string) => ({
    id: orderId,
    orderId,
    captureId: `CAP-${orderId}`,
    buyerTransactionId: `TXN-${orderId}`,
    amount: "25.00",
    currency: "USD",
    status: "available" as const,
    createdAt,
    approvalUrl: null,
    usedByRunId: null,
    usedAt: null,
  });

  it("adds each purchase once, even when the file is run twice", async () => {
    const db = await freshDb();
    const r = exportForHosted({ version: 1, purchases: [ready("O-1", "2026-10-24T10:00:00Z"), ready("O-2", "2026-10-25T10:00:00Z")] }, 5, "2026-10-25T12:00:00Z");
    if (!r.ok) throw new Error(r.error);
    const sql = hostedInsertSql(r.value.moved, "2026-10-25T12:00:00Z");
    if (!sql.ok) throw new Error(sql.error);
    await db.exec(sql.value);
    const again = await db.exec(sql.value);
    expect(again.at(-1)!.rows).toEqual([{ available: 2, used: 0 }]);
    const rows = await db.query<{ order_id: string; status: string }>("select order_id, status from public.console_purchases order by created_at");
    expect(rows.rows).toEqual([{ order_id: "O-1", status: "available" }, { order_id: "O-2", status: "available" }]);
  });
});
