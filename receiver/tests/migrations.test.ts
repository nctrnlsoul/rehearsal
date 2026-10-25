import { describe, expect, it } from "vitest";
import { freshDb, sql } from "./pg";

/**
 * The committed migrations, run in order against a real Postgres, then the
 * verify files run against the result. Nothing here touches the live project.
 */

const insertCol = (col: string, value: string) =>
  `insert into public.webhook_arrivals (${col}, instance_id) values ('${value}', 'test')`;

describe("0003 field caps (H1)", () => {
  it.each(["event_id", "event_type", "resource_id", "transmission_id"])(
    "refuses a 129-character %s and accepts 128",
    async (col) => {
      const db = await freshDb();
      await db.exec(insertCol(col, "x".repeat(128)));
      await expect(db.exec(insertCol(col, "x".repeat(129)))).rejects.toThrow(new RegExp(`${col}_len`));
    },
  );

  it("caps verify_detail at 300", async () => {
    const db = await freshDb();
    await db.exec(insertCol("verify_detail", "d".repeat(300)));
    await expect(db.exec(insertCol("verify_detail", "d".repeat(301)))).rejects.toThrow(/verify_detail_len/);
  });

  it("applies over a table that already holds an oversized row, without touching it", async () => {
    const db = await freshDb("0002_verify.sql");
    // Not an indexed column: a btree refuses a value that large before any CHECK could.
    await db.exec(insertCol("verify_detail", "9".repeat(500_000)));
    await db.exec(sql("0003_field_caps.sql"));
    const rows = await db.query<{ n: number }>("select char_length(verify_detail) as n from public.webhook_arrivals");
    expect(rows.rows).toEqual([{ n: 500_000 }]);
    await expect(db.exec(insertCol("event_type", "y".repeat(129)))).rejects.toThrow(/event_type_len/);
  });

  it("is idempotent", async () => {
    const db = await freshDb();
    await db.exec(sql("0003_field_caps.sql"));
    await expect(db.exec(insertCol("event_id", "x".repeat(129)))).rejects.toThrow(/event_id_len/);
  });

  it("its verify file passes and leaves no row behind", async () => {
    const db = await freshDb();
    const results = await db.exec(sql("0003_verify.sql"));
    const constraints = results[0]!.rows as Array<{ conname: string; convalidated: boolean }>;
    expect(constraints.map((c) => c.conname)).toEqual([
      "webhook_arrivals_event_id_len",
      "webhook_arrivals_event_type_len",
      "webhook_arrivals_instance_id_len",
      "webhook_arrivals_resource_id_len",
      "webhook_arrivals_transmission_id_len",
      "webhook_arrivals_verify_detail_len",
    ]);
    expect(constraints.every((c) => c.convalidated === false)).toBe(true);
    expect(results.at(-1)!.rows).toEqual([{ service_select: true, service_insert: true }]);
    expect((await db.query("select * from public.webhook_arrivals")).rows).toEqual([]);
  });

  it("its verify file fails loudly when the constraint is missing", async () => {
    const db = await freshDb("0002_verify.sql");
    await expect(db.exec(sql("0003_verify.sql"))).rejects.toThrow(/CHECK MISSING/);
    expect((await db.query("select * from public.webhook_arrivals")).rows).toEqual([]);
  });
});
