/**
 * The only hosts a paypal-cert-url may name. Exact, never a suffix: any
 * *.paypal.com host is wider than PayPal's API, and the URL is forwarded to
 * PayPal, which fetches it. The store holds the same list; the two deploy
 * separately, so each carries its own copy.
 */
export const PAYPAL_CERT_HOSTS: ReadonlySet<string> = new Set([
  "api.paypal.com",
  "api-m.paypal.com",
  "api.sandbox.paypal.com",
  "api-m.sandbox.paypal.com",
]);

/** Where PayPal serves its signing certs. Anything else on the host is not a cert. */
export const PAYPAL_CERT_PATH = "/v1/notifications/certs/";

/**
 * Local and pure, so it runs before any network call. On success it hands
 * back the URL as parsed, and only that form is forwarded: a raw string that
 * a different parser could read differently never leaves this app.
 */
export function checkCertUrl(raw: string): { ok: true; href: string } | { ok: false; detail: string } {
  // WHATWG parsing turns a backslash into "/", which other parsers do not, so
  // a backslash is how one string names two different URLs.
  if (raw.includes("\\")) return { ok: false, detail: "paypal-cert-url contains a backslash" };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, detail: "paypal-cert-url is not a URL" };
  }
  if (url.protocol !== "https:") return { ok: false, detail: "paypal-cert-url is not https" };
  if (url.username !== "" || url.password !== "") {
    return { ok: false, detail: "paypal-cert-url carries credentials" };
  }
  if (url.port !== "") return { ok: false, detail: "paypal-cert-url names a port" };
  if (!PAYPAL_CERT_HOSTS.has(url.hostname)) {
    const host = url.hostname.length <= 253 ? url.hostname : "an overlong host";
    return { ok: false, detail: `paypal-cert-url host ${host} is not a PayPal API host` };
  }
  if (!url.pathname.startsWith(PAYPAL_CERT_PATH) || url.search !== "" || url.hash !== "") {
    return { ok: false, detail: "paypal-cert-url is not under PayPal's cert path" };
  }
  return { ok: true, href: url.href };
}

/** The only signing algorithm PayPal uses for webhooks. */
export const PAYPAL_AUTH_ALGO = "SHA256withRSA";
/** A delivery signed further than this from now is refused, so a captured one cannot be replayed later. */
export const TRANSMISSION_WINDOW_MS = 10 * 60 * 1000;
const TRANSMISSION_ID = /^[A-Za-z0-9-]{8,64}$/;

/**
 * Cheap header checks that need no network, so a post that cannot be a fresh
 * PayPal delivery costs nothing: the algorithm PayPal signs with, an id of
 * PayPal's shape, and a transmission time within ten minutes of now. The
 * store holds the same rules.
 */
export function checkTransmission(
  headers: Headers,
  nowMs: number,
): { ok: true } | { ok: false; detail: string; outsideWindow: boolean } {
  if (headers.get("paypal-auth-algo") !== PAYPAL_AUTH_ALGO) {
    return { ok: false, detail: `paypal-auth-algo is not ${PAYPAL_AUTH_ALGO}`, outsideWindow: false };
  }
  if (!TRANSMISSION_ID.test(headers.get("paypal-transmission-id") ?? "")) {
    return { ok: false, detail: "paypal-transmission-id is not an id", outsideWindow: false };
  }
  const raw = headers.get("paypal-transmission-time") ?? "";
  const at = raw.length <= 40 ? Date.parse(raw) : Number.NaN;
  if (Number.isNaN(at)) return { ok: false, detail: "paypal-transmission-time is not a time", outsideWindow: false };
  if (Math.abs(nowMs - at) > TRANSMISSION_WINDOW_MS) {
    // PayPal's docs do not say whether a retry keeps the first transmission
    // time, and retries run for 3 days. So this is "could not check", which
    // never acts and lets PayPal retry, not a forgery that tells it to stop.
    return { ok: false, detail: "paypal-transmission-time is more than 10 minutes from now", outsideWindow: true };
  }
  return { ok: true };
}

/**
 * The verify request body, written by hand around the raw delivery. PayPal
 * signs the bytes it sent; re-serializing a parsed copy can change escapes and
 * number forms, and then a genuine delivery fails to verify. rawEvent has
 * already parsed as JSON, so the result is JSON.
 */
export function verifyRequestBody(fields: Record<string, string>, rawEvent: string): string {
  const head = JSON.stringify(fields);
  return `${head.slice(0, -1)},"webhook_event":${rawEvent}}`;
}

/** Answers that mean PayPal could not check, not that the signature is bad. */
export const couldNotCheck = (status: number): boolean =>
  status === 401 || status === 408 || status === 429 || status >= 500;
