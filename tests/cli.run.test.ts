import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    // It then stops on the missing credentials, which are only read after the
    // gate, so naming one proves the gate passed it.
    const r = runCli(card("12.00"));
    expect(r.status).toBe(2);
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

describe("rehearsal without its keys", () => {
  const spawnCli = (argv: string[], env: Record<string, string> = {}) => {
    const base: Record<string, string> = {};
    for (const name of ["PATH", "Path", "SYSTEMROOT", "SystemRoot", "TEMP", "TMP", "HOME", "USERPROFILE"]) {
      const v = process.env[name];
      if (v !== undefined) base[name] = v;
    }
    const r = spawnSync(process.execPath, [TSX, CLI, ...argv], {
      cwd,
      env: { ...base, ...env },
      encoding: "utf8",
      timeout: 60_000,
    });
    const lines = `${r.stdout}${r.stderr}`.split(/\r?\n/).filter((l) => l.trim() !== "");
    return { status: r.status, stderr: r.stderr, lines };
  };
  const noStack = (lines: string[]) => expect(lines.filter((l) => /^\s*at /.test(l))).toEqual([]);

  // A first-time user who has not set the keys yet should see what to set, not
  // a Node stack trace, and a script should be able to tell this from a halt.
  it("run prints one plain line naming the missing variable and exits 2", () => {
    const file = join(cwd, "scenario.json");
    writeFileSync(file, JSON.stringify(card("12.00")));
    const r = spawnCli(["run", file]);
    expect(r.status).toBe(2);
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]).toContain("PAYPAL_SELLER_CLIENT_ID");
    expect(r.stderr).toContain("PAYPAL_SELLER_CLIENT_ID");
    noStack(r.lines);
    // Stopped before a run id was issued, so there is no half-started run to resume.
    expect(existsSync(join(cwd, "runs"))).toBe(false);
  }, 60_000);

  it("names the next missing variable and never prints a value that is set", () => {
    const file = join(cwd, "scenario.json");
    writeFileSync(file, JSON.stringify(card("12.00")));
    const r = spawnCli(["run", file], { PAYPAL_SELLER_CLIENT_ID: "ID-VALUE-MARKER" });
    expect(r.status).toBe(2);
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]).toContain("PAYPAL_SELLER_CLIENT_SECRET");
    expect(r.lines.join("\n")).not.toContain("VALUE-MARKER");
    noStack(r.lines);
  }, 60_000);

  it("treats every command that needs a key the same way", () => {
    for (const [argv, name] of [
      [["bank:add", "--amount", "12.00"], "PAYPAL_SELLER_CLIENT_ID"],
      [["bank:confirm"], "PAYPAL_SELLER_CLIENT_ID"],
      [["plan", "a candle shop"], "ANTHROPIC_API_KEY"],
      [["find"], "ANTHROPIC_API_KEY"],
    ] as const) {
      const r = spawnCli([...argv]);
      expect(r.status, argv[0]).toBe(2);
      expect(r.lines, argv[0]).toHaveLength(1);
      expect(r.lines[0], argv[0]).toContain(name);
      noStack(r.lines);
    }
  }, 240_000);
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

describe("rehearsal with no command", () => {
  it("lists every command the CLI accepts", () => {
    const r = spawnSync(process.execPath, [TSX, CLI], { cwd, env: { PATH: process.env["PATH"] ?? "" }, encoding: "utf8", timeout: 60_000 });
    expect(r.status).toBe(0);
    const cli = readFileSync(CLI, "utf8");
    const commands = [...cli.matchAll(/^ {4}case "([a-z:-]+)":$/gm)].map((m) => m[1]!);
    expect(commands.length).toBeGreaterThanOrEqual(9);
    for (const c of commands) expect(r.stdout, c).toContain(`rehearsal ${c}`);
  }, 60_000);
});
