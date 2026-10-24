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

/** Local and pure, so it runs before any network call. */
export function checkCertUrl(raw: string): { ok: true } | { ok: false; detail: string } {
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
  return { ok: true };
}
