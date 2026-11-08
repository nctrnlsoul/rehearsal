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
// Line endings depend on the checkout (core.autocrlf), not on the README.
const readme = readFileSync(join(ROOT, "README.md"), "utf8").replace(/\r\n/g, "\n");

describe("README", () => {
  it("opens with a section for judges, before anything else", () => {
    const first = readme.indexOf("## ");
    expect(readme.slice(first, first + 25)).toBe("## Judges start here\n\n- *");
    expect(readme).toContain("https://rehearsal-indol.vercel.app");
    expect(readme).toContain("Devpost testing notes");
  });

  // 2026-11-07: in PowerShell `--amount 54.00` was silently dropped and 88.00 banked.
  it("warns Windows users, under the bank commands, that PowerShell drops the flags after --", () => {
    const bank = readme.indexOf("npm run bank:add -- --amount 54.00");
    const warn = readme.indexOf("PowerShell drops a bare `--`");
    expect(bank).toBeGreaterThan(0);
    expect(warn).toBeGreaterThan(bank);
    expect(readme.slice(bank, warn)).not.toContain("###");
    expect(readme).toContain("`npm run bank:add '--' --amount 54.00`");
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

  // Followed literally on a clean machine, the old block ran the browser tests
  // before any build and with no browser installed.
  it("builds the console and installs its browser before the browser tests", () => {
    const block = readme.slice(readme.indexOf("cd console\n"));
    const at = (s: string) => {
      const i = block.indexOf(s);
      expect(i, s).toBeGreaterThan(-1);
      return i;
    };
    expect(at("npm run build")).toBeLessThan(at("npx playwright install chromium"));
    expect(at("npx playwright install chromium")).toBeLessThan(at("npm run test:browser"));
  });

  it("no longer describes the older product", () => {
    for (const stale of [
      "No web\nconsole yet",
      "No web console yet",
      "Stage A",
      "Two environment variables",
      "Nothing in Stage A calls PayPal",
      "C:/",
      "Windows environment",
      // The store's bug was planted; the finder reproduces it, it did not discover it.
      "the bug it found",
      "caught a real bug",
      // False for the 600 s budget and the one-run-at-a-time rule.
      "can lower each one",
      // Unlinked; the Webhook Simulator and Agent Toolkit are named and linked instead.
      "PayPal's own tools",
    ]) {
      expect(readme, stale).not.toContain(stale);
    }
  });
});
