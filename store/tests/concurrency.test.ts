import { describe, expect, it } from "vitest";
import { createDb } from "../lib/db";
import { handleEvent, summarise } from "../lib/merchant";
import { freshDb } from "./pg";
import { postgrestOver } from "./postgrest";

/**
 * The audit's M1 probe, re-run against the committed migrations in a real
 * Postgres: two verified deliveries of one PAYMENT.CAPTURE.COMPLETED, handled
 * at the same time.
 *
 * What this proves: the store's calls, as they leave the app, cannot let both
 * deliveries act. What it cannot prove: PGlite runs one query at a time, so
 * the advisory lock inside store_record_event is never contended here. The
 * lock is what makes the same true on Supabase, where queries run in parallel.
 */

const CONFIG = { url: new URL("https://testproject.supabase.co"), key: "test-only-key" };

const capture = (id: string) => ({
  id,
  event_type: "PAYMENT.CAPTURE.COMPLETED",
  resource: { id: "CAP-RACE", amount: { currency_code: "USD", value: "54.00" } },
});

async function deliverTogether(dedupe: boolean, copies = 2) {
  const pg = await freshDb();
  const db = createDb(CONFIG, { fetchImpl: postgrestOver(pg) });
  const actions = await Promise.all(
    Array.from({ length: copies }, () =>
      handleEvent(db, capture("WH-RACE"), { verified: true, certHost: "api.sandbox.paypal.com", dedupe }),
    ),
  );
  return { actions, state: summarise(await db.rows()) };
}

describe("concurrent duplicate delivery (M1)", () => {
  it("with deduping on, two deliveries at once fulfill the order exactly once", async () => {
    const { actions, state } = await deliverTogether(true);
    expect(actions.sort()).toEqual(["duplicate_ignored", "fulfilled"]);
    expect(state.orders).toEqual([
      expect.objectContaining({ captureId: "CAP-RACE", fulfilmentCount: 1, duplicatesIgnored: 1 }),
    ]);
  });

  it("holds for five deliveries at once", async () => {
    const { actions } = await deliverTogether(true, 5);
    expect(actions.filter((a) => a === "fulfilled")).toHaveLength(1);
    expect(actions.filter((a) => a === "duplicate_ignored")).toHaveLength(4);
  });

  // R-009: the planted bug must still be there to find when the flag is off.
  it("with deduping off, the planted bug still fulfills twice", async () => {
    const { actions, state } = await deliverTogether(false);
    expect(actions).toEqual(["fulfilled", "fulfilled"]);
    expect(state.orders[0]!.fulfilmentCount).toBe(2);
  });

  it("a refused copy recorded first does not mark the real delivery a duplicate", async () => {
    const pg = await freshDb();
    const db = createDb(CONFIG, { fetchImpl: postgrestOver(pg) });
    await handleEvent(db, capture("WH-POISON"), { verified: false, detail: "forged", dedupe: true });
    const actions = await Promise.all([
      handleEvent(db, capture("WH-POISON"), { verified: true, dedupe: true }),
      handleEvent(db, capture("WH-POISON"), { verified: true, dedupe: true }),
    ]);
    expect(actions.sort()).toEqual(["duplicate_ignored", "fulfilled"]);
  });
});
