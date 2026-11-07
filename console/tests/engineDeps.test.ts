import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The console bundles the engine from ../src, but Vercel installs only this
 * folder, so the engine's packages come from the console's lockfile while its
 * tests run against the root's. If the two drifted, the hosted console would
 * run code no engine test ever ran. Every package the engine's runtime
 * dependencies pull in must be the same version in both lockfiles.
 */

type Lock = { packages: Record<string, { version?: string; dependencies?: Record<string, string> }> };

const ROOT = join(__dirname, "..", "..");
const lock = (...parts: string[]) => JSON.parse(readFileSync(join(ROOT, ...parts), "utf8")) as Lock;
const root = lock("package-lock.json");
const consoleLock = lock("console", "package-lock.json");

/** What the console imports the engine for. The MCP SDK is CLI-only and stays out. */
const ENGINE_RUNTIME_DEPS = ["zod", "ai", "@ai-sdk/anthropic"] as const;

/** Every package reachable from the names, as the root lockfile resolves them. */
function closure(names: readonly string[]): string[] {
  const seen = new Set<string>();
  const queue = [...names];
  while (queue.length > 0) {
    const name = queue.shift()!;
    if (seen.has(name)) continue;
    seen.add(name);
    const entry = root.packages[`node_modules/${name}`];
    if (entry === undefined) throw new Error(`${name} is not in the root lockfile`);
    queue.push(...Object.keys(entry.dependencies ?? {}));
  }
  return [...seen].sort();
}

describe("engine dependencies", () => {
  it("are installed in the console at exactly the root's versions", () => {
    const names = closure(ENGINE_RUNTIME_DEPS);
    expect(names.length).toBeGreaterThanOrEqual(ENGINE_RUNTIME_DEPS.length);
    for (const name of names) {
      const want = root.packages[`node_modules/${name}`]?.version;
      const got = consoleLock.packages[`node_modules/${name}`]?.version;
      expect({ name, version: got }).toEqual({ name, version: want });
    }
  });

  it("are pinned exactly in the console's package.json", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "console", "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    };
    for (const name of ENGINE_RUNTIME_DEPS) {
      expect(pkg.dependencies[name]).toBe(root.packages[`node_modules/${name}`]?.version);
    }
  });
});
