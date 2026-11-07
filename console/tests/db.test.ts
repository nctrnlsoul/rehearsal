import { describe, expect, it } from "vitest";
import { createDb } from "../lib/db";
import { freshDb } from "./pg";
import { postgrestOver, TEST_DB_ENV } from "./postgrest";

describe("the console's database client", () => {
  it("takes PostgREST's 204 for a function that returns void as done, not as an error", async () => {
    const pg = await freshDb();
    const rest = postgrestOver(pg);
    const db = createDb(
      { url: new URL(TEST_DB_ENV.SUPABASE_URL), key: TEST_DB_ENV.SUPABASE_SERVICE_ROLE_KEY },
      { fetchImpl: rest.fetch },
    );
    const key = "d".repeat(64);
    const taken = (await db.rpc("console_gate_take", { p_key: key, p_per_ip: 5, p_window_s: 3600 })) as {
      allowed: boolean;
      since: string;
    }[];
    expect(taken[0]!.allowed).toBe(true);
    await expect(db.rpc("console_gate_release", { p_key: key, p_since: taken[0]!.since })).resolves.toBeNull();
    const left = await pg.query<{ count: number }>("select count from public.console_counters where scope = 'gate_ip'");
    expect(left.rows[0]!.count).toBe(0);
  });
});
