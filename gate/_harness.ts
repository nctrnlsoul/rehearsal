import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Shared gate runner. Prints the PayPal ids a gate created whether it passes or
 * fails, because the ids are the evidence either way.
 *
 * The verdict token is always PASS or FAIL. A gate that could not run prints
 * FAIL with a BLOCKED qualifier: not-run must never read as passed.
 */

export type GateResult = {
  readonly ok: boolean;
  readonly reason: string;
  /** e.g. "BLOCKED", "AMBIGUOUS". Shown next to FAIL to say why it is not a pass. */
  readonly qualifier?: string;
};

export type GateContext = {
  /** Distinguishes one gate run from the next. Retries within a run share a key. */
  readonly runId: string;
  /** Records a PayPal id. Call as soon as an id exists, before the next step. */
  record(label: string, value: string): void;
  note(line: string): void;
  log(line: string): void;
};

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNS_DIR = join(HERE, "runs");
const STATE_FILE = join(RUNS_DIR, "state.json");

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Hands state between gates, e.g. the capture gate 2 must refund. */
export function saveState(key: string, value: unknown): void {
  mkdirSync(RUNS_DIR, { recursive: true });
  let all: Record<string, unknown> = {};
  try {
    all = JSON.parse(readFileSync(STATE_FILE, "utf8")) as Record<string, unknown>;
  } catch {
    all = {};
  }
  all[key] = value;
  writeFileSync(STATE_FILE, JSON.stringify(all, null, 2), "utf8");
}

/** Drops one gate's saved state so it starts from scratch. */
export function clearState(key: string): void {
  try {
    const all = JSON.parse(readFileSync(STATE_FILE, "utf8")) as Record<string, unknown>;
    if (!(key in all)) return;
    delete all[key];
    writeFileSync(STATE_FILE, JSON.stringify(all, null, 2), "utf8");
  } catch {
    // No state file means there is nothing to clear.
  }
}

export function loadState<T>(key: string): T | null {
  try {
    const all = JSON.parse(readFileSync(STATE_FILE, "utf8")) as Record<string, unknown>;
    const hit = all[key];
    return hit === undefined ? null : (hit as T);
  } catch {
    return null;
  }
}

export async function runGate(def: {
  id: string;
  title: string;
  run: (ctx: GateContext) => Promise<GateResult>;
}): Promise<void> {
  const ids: Array<{ label: string; value: string }> = [];
  const notes: string[] = [];
  const startedAt = new Date().toISOString();
  const runId = `${startedAt.slice(0, 19).replace(/[:T-]/g, "")}-${randomBytes(3).toString("hex")}`;

  const ctx: GateContext = {
    runId,
    record(label, value) {
      ids.push({ label, value });
      console.log(`  id    ${label.padEnd(28)} ${value}`);
    },
    note(line) {
      notes.push(line);
      console.log(`  note  ${line}`);
    },
    log(line) {
      console.log(`  ${line}`);
    },
  };

  console.log(`\n=== GATE ${def.id}: ${def.title} ===`);
  console.log(`  run   ${runId}`);

  let result: GateResult;
  try {
    result = await def.run(ctx);
  } catch (e) {
    const err = e as Error;
    result = { ok: false, reason: `${err.name}: ${err.message}`, qualifier: "THREW" };
  }

  const finishedAt = new Date().toISOString();
  const verdict = result.ok ? "PASS" : "FAIL";

  console.log("");
  if (ids.length === 0) {
    console.log("  PayPal ids created: none");
  } else {
    console.log("  PayPal ids created:");
    for (const { label, value } of ids) console.log(`    ${label.padEnd(28)} ${value}`);
  }
  console.log("");
  const tail = result.qualifier === undefined ? "" : ` (${result.qualifier})`;
  console.log(`${verdict}${tail}  gate ${def.id}: ${result.reason}`);

  try {
    mkdirSync(RUNS_DIR, { recursive: true });
    writeFileSync(
      join(RUNS_DIR, `gate-${def.id}-${startedAt.replace(/[:.]/g, "-")}.json`),
      JSON.stringify(
        {
          gate: def.id,
          title: def.title,
          verdict,
          qualifier: result.qualifier ?? null,
          reason: result.reason,
          runId,
          ids,
          notes,
          startedAt,
          finishedAt,
        },
        null,
        2,
      ),
      "utf8",
    );
  } catch (e) {
    console.log(`  note  could not write receipt: ${(e as Error).message}`);
  }

  process.exitCode = result.ok ? 0 : 1;
}

export function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/** Pulls a nested string by path, returning null rather than throwing. */
export function pick(body: unknown, path: readonly (string | number)[]): string | null {
  let cur: unknown = body;
  for (const key of path) {
    if (typeof key === "number") {
      if (!Array.isArray(cur)) return null;
      cur = cur[key];
    } else {
      if (typeof cur !== "object" || cur === null || Array.isArray(cur)) return null;
      cur = (cur as Record<string, unknown>)[key];
    }
  }
  return str(cur);
}

/** One-line summary of a PayPal error body, for a failing gate's reason string. */
export function errorSummary(body: unknown, preview: string): string {
  const name = pick(body, ["name"]) ?? pick(body, ["error"]);
  const message = pick(body, ["message"]) ?? pick(body, ["error_description"]);
  const issue = pick(body, ["details", 0, "issue"]);
  const desc = pick(body, ["details", 0, "description"]);
  const parts = [name, message, issue, desc].filter((p): p is string => p !== null);
  return parts.length > 0 ? parts.join(" | ") : preview.slice(0, 400);
}
