import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";

/**
 * A real Postgres (PGlite, in process) with the committed migrations applied,
 * so the SQL that ships is the SQL under test. Supabase's API roles are created
 * first, because the migrations grant and revoke on them.
 */

const DIR = join(__dirname, "..", "migrations");

export const migrationFiles = (): string[] =>
  readdirSync(DIR)
    .filter((f) => /^\d{4}_.+\.sql$/.test(f) && !f.endsWith("_verify.sql"))
    .sort();

export const sql = (file: string): string => readFileSync(join(DIR, file), "utf8");

async function migrated(upTo?: string): Promise<PGlite> {
  const db = new PGlite();
  // As on Supabase: service_role bypasses RLS, the two API roles do not.
  await db.exec("create role anon; create role authenticated; create role service_role bypassrls;");
  for (const f of migrationFiles()) {
    if (upTo !== undefined && f > upTo) break;
    await db.exec(sql(f));
  }
  return db;
}

// Migrating takes about a second; a clone of a migrated database is the same
// committed SQL, applied once per test file instead of once per test.
let template: Promise<PGlite> | null = null;

export async function freshDb(upTo?: string): Promise<PGlite> {
  if (upTo !== undefined) return migrated(upTo);
  template ??= migrated();
  return (await (await template).clone()) as PGlite;
}
