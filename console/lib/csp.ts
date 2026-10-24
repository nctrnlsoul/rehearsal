/**
 * The console's Content-Security-Policy, built per request around a fresh
 * nonce. The store can forbid scripts outright; the console cannot, because
 * the replay timeline measures its own layout to draw connectors. So scripts
 * run only with this request's nonce, and 'strict-dynamic' lets the scripts
 * Next loads that way load their own chunks and nothing else.
 */
export function contentSecurityPolicy(nonce: string, opts: { dev: boolean }): string {
  if (!/^[A-Za-z0-9+/=]{16,}$/.test(nonce)) throw new Error("CSP nonce must be base64, at least 16 characters");
  return [
    "default-src 'self'",
    // 'unsafe-eval' only under next dev, which needs it for fast refresh.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${opts.dev ? " 'unsafe-eval'" : ""}`,
    // Style attributes carry layout values (row positions, stagger); no script rides on them.
    "style-src 'self' 'unsafe-inline'",
    // The grain is an inline SVG data URI.
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

/** Base64 of 16 random bytes: unguessable per request, and valid in a CSP source. */
export function newNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes));
}
