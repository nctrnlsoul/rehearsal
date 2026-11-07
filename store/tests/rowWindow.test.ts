import { describe, expect, it } from "vitest";
import { MAX_ROWS, createDb, readWindow } from "../lib/db";
import { summarise } from "../lib/merchant";
import { freshDb } from "./pg";
import { postgrestOver } from "./postgrest";

/**
 * The webhook endpoint is public, so anyone can add refused rows. In one
 * newest-first read with a row cap, enough of them pushed PayPal's verified
 * rows out of the window and the finder read an empty store. The verified
 * rows now have their own read, and a cut in that read is reported.
 */

const CONFIG = { url: new URL("https://testproject.supabase.co"), key: "test-only-key" };

async function seed(junk: number, verified: number) {
  const pg = await freshDb();
  await pg.exec(`
    insert into public.store_order_events (event_id, event_type, capture_id, action, verified)
      select 'WH-REAL-' || g, 'PAYMENT.CAPTURE.COMPLETED', 'CAP-REAL', 'fulfilled', true from generate_series(1, ${verified}) g;
    insert into public.store_order_events (event_id, event_type, action, verified, reason)
      select 'WH-JUNK-' || g, 'PAYMENT.CAPTURE.COMPLETED', 'refused', false, 'bad sig' from generate_series(1, ${junk}) g;
  `);
  return createDb(CONFIG, { fetchImpl: postgrestOver(pg) });
}

describe("readWindow", () => {
  it("keeps verified rows when junk alone fills the row cap", async () => {
    const w = await readWindow(await seed(MAX_ROWS + 50, 1));
    const state = summarise(w.rows);
    expect(state.orders).toEqual([expect.objectContaining({ captureId: "CAP-REAL", fulfilmentCount: 1 })]);
    expect(w.truncated).toBe(false);
    expect(w.refusalsTruncated).toBe(true);
  });

  it("says so when the verified rows themselves fill the cap", async () => {
    const w = await readWindow(await seed(0, MAX_ROWS));
    expect(w.truncated).toBe(true);
    expect(w.refusalsTruncated).toBe(false);
  });
});
