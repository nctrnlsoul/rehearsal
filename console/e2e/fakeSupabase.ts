import { type Server, createServer } from "node:http";
import type { PGlite } from "@electric-sql/pglite";
import { freshDb } from "../tests/pg";
import { postgrestOver } from "../tests/postgrest";

/**
 * The console's database for the browser suite: the committed migrations in a
 * real Postgres (PGlite), behind the same fake PostgREST the unit tests use,
 * served over HTTP on localhost. The server under test reaches it through
 * e2e/redirect-supabase.mjs, which is loaded into that test process only.
 * Nothing in the app knows this exists.
 */

export const FAKE_SUPABASE_HOST = "e2e-console.supabase.co";

export async function startFakeSupabase(): Promise<{ port: number; pg: PGlite; close: () => Promise<void> }> {
  const pg = await freshDb();
  const rest = postgrestOver(pg);
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
      void rest
        .fetch(`https://${FAKE_SUPABASE_HOST}${req.url ?? "/"}`, {
          method: req.method ?? "GET",
          headers,
          ...(chunks.length > 0 ? { body: Buffer.concat(chunks).toString("utf8") } : {}),
        })
        .then(async (r) => {
          res.writeHead(r.status, { "content-type": "application/json" });
          res.end(await r.text());
        });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "localhost", () => resolve()));
  const port = (server.address() as { port: number }).port;
  return { port, pg, close: () => new Promise((r) => server.close(() => r())) };
}
