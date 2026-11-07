import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The console's .env.example is what someone deploying it reads, so it has to
 * name every variable the deployed code reads: the console's own and the
 * engine's, which the console bundles. A variable added to the code and not
 * to the example fails here.
 */

const CONSOLE = join(__dirname, "..");
const REPO = join(CONSOLE, "..");
const NAME = /["'`]((?:CONSOLE|REHEARSAL|PAYPAL|ANTHROPIC|SUPABASE)_[A-Z0-9_]+)["'`]/g;

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (name === "node_modules" || name === ".next") return [];
    return statSync(p).isDirectory() ? sources(p) : /\.(ts|tsx)$/.test(name) ? [p] : [];
  });
}

const read = (dirs: string[]) =>
  new Set(dirs.flatMap(sources).flatMap((f) => [...readFileSync(f, "utf8").matchAll(NAME)].map((m) => m[1]!)));

describe("console/.env.example", () => {
  const example = readFileSync(join(CONSOLE, ".env.example"), "utf8");

  it("names every variable the console and the engine it bundles read", () => {
    const used = read([
      join(CONSOLE, "lib"),
      join(CONSOLE, "app"),
      ...["core", "ai", "adapters", "executor", "app"].map((d) => join(REPO, "src", d)),
    ]);
    expect(used.size).toBeGreaterThan(20);
    for (const name of used) expect(example, name).toMatch(new RegExp(`^#? ?${name}=?$`, "m"));
  });

  it("says Production only, never Preview", () => {
    expect(example).toContain("PRODUCTION ONLY");
    expect(example).toMatch(/Never for\s+#?\s*Preview/);
  });
});
