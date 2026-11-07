import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * Drives the real CLI as a child process. The environment is built from
 * scratch with no PayPal credentials, so even if the guard under test were
 * missing, the run would stop at client creation and never open a socket.
 */

const TSX = resolve("node_modules/tsx/dist/cli.mjs");
const CLI = resolve("bin/rehearsal.ts");

let cwd: string;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "rehearsal-cli-"));
});
afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

function runCli(scenario: unknown, env: Record<string, string> = {}, command = "run") {
  const file = join(cwd, "scenario.json");
  writeFileSync(file, JSON.stringify(scenario));
  const base: Record<string, string> = {};
  for (const name of ["PATH", "Path", "SYSTEMROOT", "SystemRoot", "TEMP", "TMP", "HOME", "USERPROFILE"]) {
    const v = process.env[name];
    if (v !== undefined) base[name] = v;
  }
  const r = spawnSync(process.execPath, [TSX, CLI, command, file], {
    cwd,
    env: { ...base, ...env },
    encoding: "utf8",
    timeout: 60_000,
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

const card = (amount: string) => ({
  version: 1,
  name: "cli caps check",
  profile: { name: "Test Shop" },
  currency: "USD",
  steps: [{ id: "order", kind: "card_order", amount }],
});

describe("rehearsal run and dry-run <file>", () => {
  it("refuses a scenario over the per-step cap before any run starts", () => {
    const r = runCli(card("501.00"));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("exceeds the spend caps, so nothing was sent to PayPal");
    expect(r.stderr).toContain("per-step cap");
    // No run id was issued and no run state was written.
    expect(r.stdout).not.toMatch(/^run \d{14}-/m);
    expect(existsSync(join(cwd, "runs"))).toBe(false);
  }, 60_000);

  it("refuses a run total over the cap, with the caps read from the environment", () => {
    const r = runCli(card("50.00"), { REHEARSAL_MAX_RUN_TOTAL: "40.00" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("per-run cap");
    expect(r.stdout).not.toMatch(/^run \d{14}-/m);
  }, 60_000);

  it("lets a scenario inside the caps through to execution", () => {
    // It then stops on the missing credentials, which proves the gate passed it.
    const r = runCli(card("12.00"));
    expect(r.stdout).toMatch(/^run \d{14}-[0-9a-f]{6}: cli caps check$/m);
    expect(r.stderr).toContain("PAYPAL_SELLER_CLIENT_ID");
    expect(r.stderr).not.toContain("exceeds the spend caps");
  }, 60_000);

  it("dry-run refuses the same over-cap scenario run refuses, rather than showing a plan", () => {
    const r = runCli(card("501.00"), {}, "dry-run");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("exceeds the spend caps, so it would not run");
    expect(r.stderr).toContain("per-step cap");
    expect(r.stdout).not.toContain("DRY RUN");
  }, 60_000);

  it("dry-run still shows a plan inside the caps", () => {
    const r = runCli(card("12.00"), {}, "dry-run");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("DRY RUN  cli caps check");
  }, 60_000);

  it("names a malformed cap variable without echoing its value", () => {
    const r = runCli(card("12.00"), { REHEARSAL_MAX_STEP_AMOUNT: "lots-VALUE-MARKER" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("REHEARSAL_MAX_STEP_AMOUNT");
    expect(`${r.stdout}${r.stderr}`).not.toContain("VALUE-MARKER");
  }, 60_000);
});

describe("rehearsal bank:add", () => {
  // Its order is a write, so the per-step cap applies before any client exists.
  it("refuses an amount over the per-step cap before creating anything", () => {
    const base: Record<string, string> = {};
    for (const name of ["PATH", "Path", "SYSTEMROOT", "SystemRoot", "TEMP", "TMP", "HOME", "USERPROFILE"]) {
      const v = process.env[name];
      if (v !== undefined) base[name] = v;
    }
    const r = spawnSync(process.execPath, [TSX, CLI, "bank:add", "--amount", "900.00"], {
      cwd,
      env: base,
      encoding: "utf8",
      timeout: 60_000,
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("purchase of USD 900.00 is over the per-step cap of USD 500.00, so no order was created");
    expect(existsSync(join(cwd, "bank"))).toBe(false);
  }, 60_000);
});
