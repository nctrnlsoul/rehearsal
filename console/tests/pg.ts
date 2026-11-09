import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";

/**
 * A real Postgres (PGlite, in process) with the committed migrations applied,
 * so the SQL that ships is the SQL under test. Supabase's API roles are created
 * first, with Supabase's default privileges: every new table, sequence and
 * function in public is granted ALL to anon, authenticated and service_role.
 * The migrations must take those back themselves, so they are tested against
 * what a real project hands them, not against a clean slate.
 */

export const SUPABASE_ROLES = `
  create role anon nologin noinherit;
  create role authenticated nologin noinherit;
  create role service_role nologin noinherit bypassrls;
  grant usage on schema public to anon, authenticated, service_role;
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
  alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
  -- Supabase's own SECURITY DEFINER function behind automatic RLS, which 0005
  -- locks. A stand-in with the same signature and the same default grants.
  create function public.rls_auto_enable() returns event_trigger language plpgsql security definer as $$ begin end $$;
`;

const DIR = join(__dirname, "..", "migrations");

export const migrationFiles = (): string[] =>
  readdirSync(DIR)
    .filter((f) => /^\d{4}_.+\.sql$/.test(f) && !f.endsWith("_verify.sql"))
    .sort();

export const sql = (file: string): string => readFileSync(join(DIR, file), "utf8");

async function migrated(upTo?: string): Promise<PGlite> {
  const db = new PGlite();
  // As on Supabase: service_role bypasses RLS, the two API roles do not.
  await db.exec(SUPABASE_ROLES);
  for (const f of migrationFiles()) {
    if (upTo !== undefined && f > upTo) break;
    await db.exec(sql(f));
  }
  return db;
}

// Migrating takes about a second; a clone of a migrated database is the same
// committed SQL, applied once per test file instead of once per test.
let template: Promise<PGlite> | null = null;

// Every database a test gets is closed after that test (tests/setup.ts).
// Each PGlite holds its own WASM Postgres; left open, a file's worth of them
// used ~6.5 GB and CI runners killed the workers ("The operation was canceled").
const open = new Set<PGlite>();

export async function freshDb(upTo?: string): Promise<PGlite> {
  const db =
    upTo !== undefined ? await migrated(upTo) : ((await (await (template ??= migrated())).clone()) as PGlite);
  open.add(db);
  return db;
}

/** Closes every database handed out since the last call. The template stays open. */
export async function closeOpenDbs(): Promise<void> {
  const dbs = [...open];
  open.clear();
  await Promise.all(dbs.map((db) => (db.closed ? undefined : db.close())));
}
