import type { PGlite } from "@electric-sql/pglite";

/**
 * Just enough of PostgREST, over a real Postgres, for the store's own calls:
 * the row insert, the row read, the old event-id lookup and the
 * store_record_event RPC. Each call waits a few milliseconds first, the way a
 * network round trip does, so two deliveries handled together interleave the
 * way they do on Vercel.
 */

const COLUMNS = [
  "event_id",
  "event_type",
  "capture_id",
  "amount",
  "currency",
  "action",
  "verified",
  "reason",
  "cert_host",
] as const;

const latency = () => new Promise((r) => setTimeout(r, 5));

export function postgrestOver(pg: PGlite): typeof fetch {
  return (async (input: string | URL | Request, init: RequestInit = {}) => {
    await latency();
    const url = new URL(String(input));
    const method = init.method ?? "GET";
    const body = typeof init.body === "string" ? (JSON.parse(init.body) as unknown) : null;

    if (url.pathname === "/rest/v1/rpc/store_record_event" && method === "POST") {
      const a = body as Record<string, string | null>;
      const r = await pg.query<{ out: string }>(
        "select public.store_record_event($1, $2, $3, $4, $5, $6, $7) as out",
        [a["p_event_id"], a["p_event_type"], a["p_capture_id"], a["p_amount"], a["p_currency"], a["p_action"], a["p_cert_host"]],
      );
      return Response.json(r.rows[0]!.out);
    }

    if (url.pathname === "/rest/v1/store_order_events" && method === "POST") {
      for (const row of body as Array<Record<string, unknown>>) {
        await pg.query(
          `insert into public.store_order_events (${COLUMNS.join(", ")}) values (${COLUMNS.map((_, i) => `$${i + 1}`).join(", ")})`,
          COLUMNS.map((c) => row[c] ?? null),
        );
      }
      return new Response(null, { status: 201 });
    }

    if (url.pathname === "/rest/v1/store_order_events" && method === "GET") {
      const eventId = url.searchParams.get("event_id");
      if (eventId !== null) {
        // The lookup the store made before M1: verified, non-refused rows only.
        const r = await pg.query(
          "select id from public.store_order_events where event_id = $1 and verified is true and action <> 'refused' limit 1",
          [eventId.replace(/^eq\./, "")],
        );
        return Response.json(r.rows);
      }
      const r = await pg.query(
        `select ${COLUMNS.join(", ")}, received_at::text as received_at from public.store_order_events order by id desc`,
      );
      return Response.json(r.rows);
    }

    return new Response(null, { status: 404 });
  }) as typeof fetch;
}
