/**
 * Readers for untyped PayPal response bodies. They return null rather than
 * throwing, so a caller can decide that a missing field means "unknown" instead
 * of crashing mid-run.
 */

export function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/** Pulls a nested string by path. A wrong path yields null, never an exception. */
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

const ERROR_PART_MAX = 200;

/** Printable and short: these parts reach run reports, MCP output and the console. */
function clip(raw: string, max: number): string {
  const flat = raw.replace(/[\p{Cc}\p{Cf}]+/gu, " ").replace(/\s+/g, " ").trim();
  const chars = Array.from(flat);
  return chars.length <= max ? flat : chars.slice(0, max).join("").trimEnd();
}

/**
 * One-line summary of a PayPal error body, for a failing step's detail string.
 * Only PayPal's named error fields are read. The raw body is never quoted: it
 * is saved with the run and served by the console, and a reply that is not
 * PayPal's error shape (a proxy page, an echo of the request) has no business
 * there. The debug id is what PayPal support asks for.
 */
export function errorSummary(body: unknown, debugId: string | null): string {
  const name = pick(body, ["name"]) ?? pick(body, ["error"]);
  const message = pick(body, ["message"]) ?? pick(body, ["error_description"]);
  const issue = pick(body, ["details", 0, "issue"]);
  const description = pick(body, ["details", 0, "description"]);
  const parts = [name, message, issue, description]
    .filter((p): p is string => p !== null)
    .map((p) => clip(p, ERROR_PART_MAX))
    .filter((p) => p !== "");
  if (parts.length > 0) return parts.join(" | ");
  const id = debugId ?? pick(body, ["debug_id"]);
  const safeId = id === null ? "" : clip(id, 40).replace(/[^A-Za-z0-9_-]/g, "");
  return `no PayPal error name in the reply${safeId === "" ? "" : `, debug id ${safeId}`}`;
}
