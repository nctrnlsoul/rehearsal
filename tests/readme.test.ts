import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The README is what a judge runs first. Its offline command must work on a
 * clean machine (no keys, no allowed event origins), and the lines that
 * described an older product must stay gone.
 */

const ROOT = resolve(__dirname, "..");
const readme = readFileSync(join(ROOT, "README.md"), "utf8");

describe("README", () => {
  it("opens with a section for judges, before anything else", () => {
    const first = readme.indexOf("## ");
    expect(readme.slice(first, first + 25)).toBe("## Judges start here\n\n- *");
    expect(readme).toContain("https://rehearsal-indol.vercel.app");
    expect(readme).toContain("Devpost testing notes");
  });

  it("names a first dry run that succeeds with no keys and no allowed origins", () => {
    const command = "npm run dry-run scenarios/quick-start.json";
    expect(readme).toContain(command);
    const cwd = mkdtempSync(join(tmpdir(), "rehearsal-readme-"));
    try {
      const env: Record<string, string> = {};
      for (const name of ["PATH", "Path", "SYSTEMROOT", "SystemRoot", "TEMP", "TMP"]) {
        const v = process.env[name];
        if (v !== undefined) env[name] = v;
      }
      const r = spawnSync(
        process.execPath,
        [join(ROOT, "node_modules/tsx/dist/cli.mjs"), join(ROOT, "bin/rehearsal.ts"), "dry-run", join(ROOT, "scenarios/quick-start.json")],
        { cwd, env, encoding: "utf8", timeout: 60_000 },
      );
      expect(r.stderr).toBe("");
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("no network calls were made to produce this plan");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 60_000);

  it("no longer describes the older product", () => {
    for (const stale of ["No web\nconsole yet", "No web console yet", "Stage A", "Two environment variables", "Nothing in Stage A calls PayPal", "C:/", "Windows environment"]) {
      expect(readme, stale).not.toContain(stale);
    }
  });
});
