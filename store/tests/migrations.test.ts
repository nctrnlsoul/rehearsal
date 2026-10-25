import { describe, expect, it } from "vitest";
import { freshDb, sql } from "./pg";

/**
 * The committed migrations, run in order against a real Postgres, then the
 * verify files run against the result. Nothing here touches the live project.
 */

const insert = (eventId: string, extra = "") =>
  `insert into public.store_order_events (event_id, event_type, action${extra === "" ? "" : ", capture_id"})
   values ('${eventId}', 'PAYMENT.CAPTURE.COMPLETED', 'fulfilled'${extra === "" ? "" : `, '${extra}'`})`;

describe("0004 field caps (H1)", () => {
  it("refuses a 129-character event id, capture id, amount or currency, and accepts 128", async () => {
    const db = await freshDb();
    await db.exec(insert("x".repeat(128)));
    await expect(db.exec(insert("x".repeat(129)))).rejects.toThrow(/store_order_events_event_id_len/);
    await expect(db.exec(insert("E-1", "c".repeat(129)))).rejects.toThrow(/capture_id_len/);
    await expect(
      db.exec(`insert into public.store_order_events (event_type, action, amount) values ('T', 'refused', '${"9".repeat(129)}')`),
    ).rejects.toThrow(/amount_len/);
    await expect(
      db.exec(`insert into public.store_order_events (event_type, action, currency) values ('T', 'refused', '${"U".repeat(129)}')`),
    ).rejects.toThrow(/currency_len/);
    await expect(
      db.exec(`insert into public.store_order_events (event_type, action) values ('${"T".repeat(129)}', 'refused')`),
    ).rejects.toThrow(/event_type_len/);
  });

  it("applies over a table that already holds an oversized row, without touching it", async () => {
    const db = await freshDb("0003_refusal_reason.sql");
    // The shape the audit's probe left behind on the live table. Not in an
    // indexed column: a btree refuses a value that large before any CHECK could.
    await db.exec(
      `insert into public.store_order_events (event_type, action, amount) values ('T', 'refused', '${"9".repeat(500_000)}')`,
    );
    await db.exec(sql("0004_field_caps.sql"));
    const rows = await db.query<{ n: number }>("select char_length(amount) as n from public.store_order_events");
    expect(rows.rows).toEqual([{ n: 500_000 }]);
    await expect(db.exec(insert("y".repeat(129)))).rejects.toThrow(/event_id_len/);
  });

  it("is idempotent", async () => {
    const db = await freshDb();
    await db.exec(sql("0004_field_caps.sql"));
    await expect(db.exec(insert("x".repeat(129)))).rejects.toThrow(/event_id_len/);
  });

  it("its verify file passes and leaves no row behind", async () => {
    const db = await freshDb();
    const results = await db.exec(sql("0004_verify.sql"));
    const constraints = results[0]!.rows as Array<{ conname: string; convalidated: boolean }>;
    expect(constraints).toHaveLength(8);
    for (const c of constraints) {
      expect(c.convalidated).toBe(c.conname.endsWith("_reason_len") || c.conname.endsWith("_cert_host_len"));
    }
    expect(results.at(-1)!.rows).toEqual([{ service_select: true, service_insert: true }]);
    const left = await db.query("select * from public.store_order_events");
    expect(left.rows).toEqual([]);
  });

  it("its verify file fails loudly when the constraint is missing", async () => {
    const db = await freshDb("0003_refusal_reason.sql");
    await expect(db.exec(sql("0004_verify.sql"))).rejects.toThrow(/CHECK MISSING/);
    const left = await db.query("select * from public.store_order_events");
    expect(left.rows).toEqual([]);
  });
});

describe("0005 store_record_event (M1)", () => {
  const call = (id: string | null, action = "fulfilled") =>
    `select public.store_record_event(${id === null ? "null" : `'${id}'`}, 'PAYMENT.CAPTURE.COMPLETED', 'CAP-1', '1.00', 'USD', '${action}', null) as out`;

  it("records the first delivery as its action and the next as a duplicate", async () => {
    const db = await freshDb();
    expect((await db.query(call("WH-1"))).rows).toEqual([{ out: "fulfilled" }]);
    expect((await db.query(call("WH-1"))).rows).toEqual([{ out: "duplicate_ignored" }]);
    expect((await db.query(call("WH-2", "refund_recorded"))).rows).toEqual([{ out: "refund_recorded" }]);
    const rows = await db.query("select event_id, action, verified from public.store_order_events order by id");
    expect(rows.rows).toEqual([
      { event_id: "WH-1", action: "fulfilled", verified: true },
      { event_id: "WH-1", action: "duplicate_ignored", verified: true },
      { event_id: "WH-2", action: "refund_recorded", verified: true },
    ]);
  });

  it("does not count a refused or unverified row as seen", async () => {
    const db = await freshDb();
    await db.exec(`insert into public.store_order_events (event_id, event_type, action, verified)
                   values ('WH-1', 'T', 'refused', false), ('WH-1', 'T', 'fulfilled', null)`);
    expect((await db.query(call("WH-1"))).rows).toEqual([{ out: "fulfilled" }]);
  });

  it("refuses a null event id and any action it does not record", async () => {
    const db = await freshDb();
    await expect(db.query(call(null))).rejects.toThrow(/needs an event id/);
    await expect(db.query(call("WH-1", "refused"))).rejects.toThrow(/does not record/);
    await expect(db.query(call("WH-1", "duplicate_ignored"))).rejects.toThrow(/does not record/);
  });

  it("is executable by service_role only", async () => {
    const db = await freshDb();
    await db.exec("set role anon");
    await expect(db.query(call("WH-1"))).rejects.toThrow(/permission denied/);
    await db.exec("reset role; set role authenticated");
    await expect(db.query(call("WH-1"))).rejects.toThrow(/permission denied/);
    await db.exec("reset role; set role service_role");
    expect((await db.query(call("WH-1"))).rows).toEqual([{ out: "fulfilled" }]);
  });

  it("is idempotent", async () => {
    const db = await freshDb();
    await db.exec(sql("0005_record_event.sql"));
    expect((await db.query(call("WH-1"))).rows).toEqual([{ out: "fulfilled" }]);
  });

  it("its verify file passes and leaves no row behind", async () => {
    const db = await freshDb();
    const results = await db.exec(sql("0005_verify.sql"));
    expect(results[0]!.rows).toEqual([
      { proname: "store_record_event", security_invoker: true, config: ['search_path=""'] },
    ]);
    expect(results[1]!.rows).toEqual([
      { service_execute: true, anon_execute: false, authenticated_execute: false, public_execute: false },
    ]);
    expect((await db.query("select * from public.store_order_events")).rows).toEqual([]);
  });

  it("its verify file fails loudly when the function is missing", async () => {
    const db = await freshDb("0004_verify.sql");
    await expect(db.exec(sql("0005_verify.sql"))).rejects.toThrow(/store_record_event/);
  });
});
