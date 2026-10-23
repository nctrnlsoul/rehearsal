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

/** One-line summary of a PayPal error body, for a failing step's detail string. */
export function errorSummary(body: unknown, preview: string): string {
  const name = pick(body, ["name"]) ?? pick(body, ["error"]);
  const message = pick(body, ["message"]) ?? pick(body, ["error_description"]);
  const issue = pick(body, ["details", 0, "issue"]);
  const description = pick(body, ["details", 0, "description"]);
  const parts = [name, message, issue, description].filter((p): p is string => p !== null);
  return parts.length > 0 ? parts.join(" | ") : preview.slice(0, 400);
}
