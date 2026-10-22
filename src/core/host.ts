/**
 * Host pinning. REHEARSAL creates real financial records, so the sandbox host is
 * a hard precondition rather than a configurable base URL: there is no env var
 * that can point this at live PayPal, by construction.
 */

export const SANDBOX_HOST = "api-m.sandbox.paypal.com";

export class HostRefusedError extends Error {
  /** Scheme, host, port and path only. Userinfo and query are stripped so a
   *  refused URL can be logged without leaking whatever it carried. */
  readonly redactedTarget: string;

  constructor(reason: string, redactedTarget: string) {
    super(`PayPal target refused: ${reason}`);
    this.name = "HostRefusedError";
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

export function assertSandboxUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new HostRefusedError("not a parseable absolute URL", "<unparseable>");
  }

  const target = redact(raw);

  if (url.protocol !== "https:") {
    throw new HostRefusedError(`scheme ${url.protocol} is not https:`, target);
  }
  // Checked before the host compare: "https://api-m.sandbox.paypal.com@evil.test"
  // has hostname evil.test, but a human reading the string sees the sandbox host.
  if (url.username !== "" || url.password !== "") {
    throw new HostRefusedError("URL carries userinfo", target);
  }
  if (url.hostname !== SANDBOX_HOST) {
    throw new HostRefusedError(`host ${url.hostname} is not ${SANDBOX_HOST}`, target);
  }
  if (url.port !== "" && url.port !== "443") {
    throw new HostRefusedError(`port ${url.port} is not 443`, target);
  }
  return url;
}

/**
 * Builds a sandbox URL from a path. Paths carry ids taken from API responses, so
 * the path is validated before concatenation and the result is re-asserted.
 */
export function sandboxUrl(path: string): URL {
  if (!path.startsWith("/")) {
    throw new HostRefusedError("path must start with a single forward slash", "<path>");
  }
  if (path.startsWith("//")) {
    throw new HostRefusedError("path must not start with a double slash", "<path>");
  }
  if (/[\\\s]/.test(path)) {
    throw new HostRefusedError("path contains a backslash or whitespace", "<path>");
  }
  // eslint-disable-next-line no-control-regex -- control characters are the point
  if (/[\u0000-\u001f\u007f]/.test(path)) {
    throw new HostRefusedError("path contains a control character", "<path>");
  }
  return assertSandboxUrl(`https://${SANDBOX_HOST}${path}`);
}
