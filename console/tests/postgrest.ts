import type { PGlite } from "@electric-sql/pglite";

/**
 * Just enough of PostgREST, over a real Postgres, for the console's calls:
 * POST /rest/v1/rpc/<function> with named arguments, answered the way
 * PostgREST answers (a set-returning function gives an array of rows, any
 * other a single JSON value). A wrong apikey gets 401, so a test proves the
 * key is sent. `down` makes every call fail, for the fail-closed tests.
 * Each call waits a few milliseconds first, as a network round trip does.
 */

export type FakeRest = {
  readonly fetch: typeof fetch;
  /** Calls made, by function name, in order. */
  readonly calls: string[];
  down: boolean;
};

export const TEST_DB_ENV = {
  SUPABASE_URL: "https://console-test.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "sb_secret_test_key_for_pglite_only",
} as const;

const latency = () => new Promise((r) => setTimeout(r, 2));

export function postgrestOver(pg: PGlite, key: string = TEST_DB_ENV.SUPABASE_SERVICE_ROLE_KEY): FakeRest {
  const state: FakeRest = {
    calls: [],
    down: false,
    fetch: (async (input: string | URL | Request, init: RequestInit = {}) => {
      await latency();
      if (state.down) return new Response(null, { status: 503 });
      const url = new URL(String(input));
      const headers = new Headers(init.headers);
      if (headers.get("apikey") !== key) return new Response(null, { status: 401 });
      const m = /^\/rest\/v1\/rpc\/([a-z_]+)$/.exec(url.pathname);
      if (m === null || (init.method ?? "GET") !== "POST") return new Response(null, { status: 404 });
      const name = m[1]!;
      state.calls.push(name);
      const args = (typeof init.body === "string" ? JSON.parse(init.body) : {}) as Record<string, unknown>;

      const proc = await pg.query<{ proretset: boolean }>(
        "select p.proretset from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = $1",
        [name],
      );
      if (proc.rows.length !== 1) return new Response(null, { status: 404 });

      const names = Object.keys(args);
      const params = names.map((k) => {
        const v = args[k];
        // jsonb arguments travel as JSON text; arrays of scalars as arrays.
        return typeof v === "object" && v !== null && !(Array.isArray(v) && v.every((x) => typeof x !== "object")) ? JSON.stringify(v) : v;
      });
      const call = `public.${name}(${names.map((k, i) => `${k} => $${i + 1}`).join(", ")})`;
      try {
        if (proc.rows[0]!.proretset) {
          const r = await pg.query(`select * from ${call}`, params);
          return Response.json(r.rows);
        }
        const r = await pg.query<{ v: unknown }>(`select ${call} as v`, params);
        return Response.json(r.rows[0]!.v ?? null);
      } catch {
        // PostgREST answers a raised exception or a constraint failure with a 4xx.
        return new Response(null, { status: 400 });
      }
    }) as typeof fetch,
  };
  return state;
}
