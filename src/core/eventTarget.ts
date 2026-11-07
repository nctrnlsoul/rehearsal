/**
 * Outbound event-target allowlist. REHEARSAL fires real PayPal events at a URL,
 * which makes that URL a weapon if it is ever attacker-controlled. The allowlist
 * is a required argument rather than an option with a default, and an empty
 * allowlist refuses everything instead of allowing everything.
 */

export class TargetRefusedError extends Error {
  readonly redactedTarget: string;

  constructor(reason: string, redactedTarget: string) {
    super(`event target refused: ${reason}`);
    this.name = "TargetRefusedError";
    this.redactedTarget = redactedTarget;
  }
}

function redact(raw: string): string {
  try {
    const u = new URL(raw);
    const port = u.port === "" ? "" : `:${u.port}`;
    return `${u.protocol}//${u.hostname}${port}${u.pathname}`;
  } catch {
    return "<unparseable>";
  }
}

/** Scheme + host + non-default port. Throws on anything that is not a plain https origin. */
export function normalizeOrigin(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new TargetRefusedError("not a parseable absolute URL", "<unparseable>");
  }
  const target = redact(raw);
  if (u.protocol !== "https:") {
    throw new TargetRefusedError(`scheme ${u.protocol} is not https:`, target);
  }
  if (u.username !== "" || u.password !== "") {
    throw new TargetRefusedError("URL carries userinfo", target);
  }
  if (u.hostname === "") {
    throw new TargetRefusedError("URL has no host", target);
  }
  const port = u.port === "" || u.port === "443" ? "" : `:${u.port}`;
  return `https://${u.hostname}${port}`;
}

export function assertAllowedEventTarget(raw: string, allowlist: readonly string[]): URL {
  if (allowlist.length === 0) {
    throw new TargetRefusedError("allowlist is empty, so no target is permitted", redact(raw));
  }
  // Normalizing the allowlist can throw. That is deliberate: a bad allowlist entry
  // is a configuration error, and skipping it would quietly shrink the guard.
  const allowed = new Set(allowlist.map(normalizeOrigin));
  const origin = normalizeOrigin(raw);
  if (!allowed.has(origin)) {
    throw new TargetRefusedError(`origin ${origin} is not on the allowlist`, redact(raw));
  }
  return new URL(raw);
}

/** The route every app REHEARSAL fires at serves PayPal deliveries on. */
export const WEBHOOK_HANDLER_PATH = "/api/paypal/webhook";

export function webhookHandlerUrl(origin: string): string {
  return `${normalizeOrigin(origin)}${WEBHOOK_HANDLER_PATH}`;
}

/**
 * A webhook target must be an allowlisted origin's handler URL, character for
 * character. The origin check alone let a bare origin through: PayPal accepted
 * the registration, deliveries and resends went to a page that is not the
 * handler, and a duplicate the app never received reads as the app coping.
 */
export function assertWebhookHandlerTarget(raw: string, allowlist: readonly string[]): URL {
  const url = assertAllowedEventTarget(raw, allowlist);
  const expected = webhookHandlerUrl(raw);
  if (raw !== expected) {
    throw new TargetRefusedError(`webhook target must be exactly ${expected}`, redact(raw));
  }
  return url;
}

export type AllowlistSource = { readonly name: string; readonly value: string | null };

/**
 * Reads the event-origin allowlist from configuration, once, at the boundary.
 * A malformed entry is a configuration error that stops the command with a
 * message naming where it came from. Skipping it would quietly shrink the
 * guard, and letting it through crashed the planner with a stack trace. The
 * value itself is never echoed, because it comes from the environment.
 */
export function parseEventAllowlist(
  sources: readonly AllowlistSource[],
): { ok: true; origins: string[] } | { ok: false; error: string } {
  const origins: string[] = [];
  for (const source of sources) {
    if (source.value === null) continue;
    const entries = source.value
      .split(",")
      .map((v) => v.trim())
      .filter((v) => v !== "");
    for (const [i, entry] of entries.entries()) {
      try {
        origins.push(normalizeOrigin(entry));
      } catch (e) {
        const reason =
          e instanceof TargetRefusedError
            ? e.message.replace(/^event target refused: /, "")
            : "unreadable";
        return {
          ok: false,
          error: `${source.name} entry ${i + 1} is not a usable origin (${reason}). It must look like https://host. Fix it where your environment variables are set.`,
        };
      }
    }
  }
  return { ok: true, origins: [...new Set(origins)] };
}
