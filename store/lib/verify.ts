import { accessToken, forgetToken } from "./paypalToken";

const SANDBOX_HOST = "api-m.sandbox.paypal.com";

/**
 * Signature verification against PayPal.
 *
 * The store refuses to act on anything that does not verify, so this is an
 * authentication boundary rather than a diagnostic. A failure and an
 * inability to check are both reported, and both stop the event acting.
 *
 * The webhook id is pinned in env (REHEARSAL_STORE_WEBHOOK_ID), or discovered
 * by asking PayPal which webhook points at this app's exact handler URL, built
 * from REHEARSAL_STORE_ORIGIN. Discovery means the store can verify without
 * someone pasting an id that only exists after the first run.
 */

export type VerifyResult = {
  /** true verified, false failed, null could not be attempted. */
  verified: boolean | null;
  detail: string;
};

/** The route this app serves PayPal deliveries on. A webhook anywhere else is not ours. */
export const STORE_WEBHOOK_PATH = "/api/paypal/webhook";

/** Keyed by the exact handler URL, so a deployment reached by two hosts never mixes them. */
const cachedWebhookIds = new Map<string, string>();

export type WebhookIdResult = { id: string } | { id: null; detail: string };

/**
 * The only hosts a paypal-cert-url may name. Exact, never a suffix: any
 * *.paypal.com host is wider than PayPal's API, and the URL is forwarded to
 * PayPal, which fetches it.
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
 * The cert URL's own checks, local and pure, so they run before any network
 * call. On success it hands back the URL as parsed, and only that form is
 * forwarded: a raw string that a different parser could read differently
 * never leaves this app.
 */
export function checkCertUrl(raw: string): { ok: true; href: string } | { ok: false; detail: string } {
  // WHATWG parsing turns "\" into "/", which other parsers do not, so a
  // backslash is how one string names two different URLs.
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
 * PayPal's shape, and a transmission time within ten minutes of now.
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
const couldNotCheck = (status: number): boolean => status === 401 || status === 408 || status === 429 || status >= 500;

/** Every PayPal delivery carries these. Lacking any one, it is not a delivery. */
const REQUIRED_HEADERS = [
  "paypal-transmission-id",
  "paypal-transmission-time",
  "paypal-transmission-sig",
  "paypal-auth-algo",
  "paypal-cert-url",
] as const;

/**
 * The one webhook PayPal has registered for this app's exact handler URL.
 *
 * Exact, never a prefix: a webhook at the bare origin, or on a host that merely
 * starts with ours, is a different webhook, and verifying against its id makes
 * every genuine delivery fail. Zero matches or several both refuse, because
 * guessing between two ids is how the wrong one gets picked.
 */
export async function resolveWebhookId(
  env: Record<string, string | undefined>,
  selfOrigin: string,
  fetchImpl: typeof fetch = fetch,
): Promise<WebhookIdResult> {
  const override = env["REHEARSAL_STORE_WEBHOOK_ID"];
  if (override !== undefined && override.trim() !== "") return { id: override.trim() };

  const handlerUrl = `${selfOrigin}${STORE_WEBHOOK_PATH}`;
  const cached = cachedWebhookIds.get(handlerUrl);
  if (cached !== undefined) return { id: cached };

  const clientId = env["PAYPAL_SELLER_CLIENT_ID"];
  const clientSecret = env["PAYPAL_SELLER_CLIENT_SECRET"];
  if (!clientId?.trim() || !clientSecret?.trim()) {
    return { id: null, detail: "store holds no PayPal credentials, cannot look up its webhook" };
  }

  let list: unknown[];
  try {
    const bearer = await accessToken(clientId, clientSecret, fetchImpl);
    if (bearer === null) return { id: null, detail: "could not get a PayPal token" };

    const res = await fetchImpl(`https://${SANDBOX_HOST}/v1/notifications/webhooks`, {
      headers: { Authorization: `Bearer ${bearer}`, Accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(8000),
    });
    if (res.status === 401) forgetToken();
    if (!res.ok) return { id: null, detail: `webhook list http ${res.status}` };
    const body = (await res.json()) as { webhooks?: unknown };
    if (!Array.isArray(body.webhooks)) {
      return { id: null, detail: "webhook list was not an array" };
    }
    list = body.webhooks;
  } catch (e) {
    return { id: null, detail: `webhook lookup threw: ${(e as Error).name}` };
  }

  const ids = list
    .filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null)
    .filter((rec) => rec["url"] === handlerUrl && typeof rec["id"] === "string")
    .map((rec) => rec["id"] as string);

  if (ids.length === 0) {
    return { id: null, detail: "no webhook is registered for this store's handler URL" };
  }
  if (ids.length > 1) {
    return {
      id: null,
      detail: `${ids.length} webhooks are registered for this store's handler URL, refusing to pick one`,
    };
  }

  // Only a clean single match is cached. A refusal is not, so a webhook
  // registered later is picked up without a redeploy.
  cachedWebhookIds.set(handlerUrl, ids[0]!);
  return { id: ids[0]! };
}

export const STORE_ORIGIN_VAR = "REHEARSAL_STORE_ORIGIN";

/**
 * The store's own origin, from env, never from the request (audit 2026-10-25
 * L4). The request's Host is chosen by whoever sends it: every alias of the
 * deployment is a different handler URL, so each one cost a fresh webhook
 * lookup and a new cache entry. An origin with a path, query or credentials is
 * refused rather than trimmed, because a guessed-at origin finds the wrong
 * webhook.
 */
export function storeOrigin(
  env: Record<string, string | undefined>,
): { origin: string } | { origin: null; detail: string } {
  const raw = (env[STORE_ORIGIN_VAR] ?? "").trim();
  if (raw === "") {
    return {
      origin: null,
      detail: `store has neither REHEARSAL_STORE_WEBHOOK_ID nor ${STORE_ORIGIN_VAR}, so it cannot name its webhook`,
    };
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { origin: null, detail: `${STORE_ORIGIN_VAR} is not a URL` };
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    return { origin: null, detail: `${STORE_ORIGIN_VAR} is not https` };
  }
  const originOnly =
    url.pathname === "/" && url.search === "" && url.hash === "" && url.username === "" && url.password === "" && !raw.endsWith("?") && !raw.endsWith("#");
  if (!originOnly) {
    return { origin: null, detail: `${STORE_ORIGIN_VAR} must be an origin only, like https://host` };
  }
  return { origin: url.origin };
}

export async function verifySignature(
  headers: Headers,
  rawEvent: string,
  env: Record<string, string | undefined>,
  fetchImpl: typeof fetch = fetch,
  nowMs: number = Date.now(),
): Promise<VerifyResult> {
  const clientId = env["PAYPAL_SELLER_CLIENT_ID"];
  const clientSecret = env["PAYPAL_SELLER_CLIENT_SECRET"];
  if (!clientId?.trim() || !clientSecret?.trim()) {
    return { verified: null, detail: "store holds no PayPal credentials, cannot verify" };
  }

  // Local checks first. The endpoint is public, so a request that cannot be
  // PayPal's must be refused before it costs a token call and a webhook lookup.
  const missing = REQUIRED_HEADERS.filter((h) => (headers.get(h) ?? "").trim() === "");
  if (missing.length > 0) {
    return { verified: false, detail: `missing ${missing.join(", ")}` };
  }

  // cert_url arrives from the request and PayPal will fetch it. We do not fetch
  // it, but we refuse to forward anything but a PayPal cert URL.
  const cert = checkCertUrl(headers.get("paypal-cert-url") ?? "");
  if (!cert.ok) return { verified: false, detail: cert.detail };
  const transmission = checkTransmission(headers, nowMs);
  if (!transmission.ok) {
    return transmission.outsideWindow
      ? { verified: null, detail: `could not check: ${transmission.detail}` }
      : { verified: false, detail: transmission.detail };
  }

  // A pinned webhook id needs no origin; otherwise the origin comes from env.
  const pinnedId = (env["REHEARSAL_STORE_WEBHOOK_ID"] ?? "").trim() !== "";
  const self = storeOrigin(env);
  if (!pinnedId && self.origin === null) return { verified: null, detail: self.detail };
  const resolved = await resolveWebhookId(env, self.origin ?? "", fetchImpl);
  if (resolved.id === null) return { verified: null, detail: resolved.detail };
  const webhookId = resolved.id;

  try {
    const bearer = await accessToken(clientId, clientSecret, fetchImpl);
    if (bearer === null) return { verified: null, detail: "could not get a PayPal token" };

    const res = await fetchImpl(
      `https://${SANDBOX_HOST}/v1/notifications/verify-webhook-signature`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
        body: verifyRequestBody(
          {
            auth_algo: headers.get("paypal-auth-algo") ?? "",
            cert_url: cert.href,
            transmission_id: headers.get("paypal-transmission-id") ?? "",
            transmission_sig: headers.get("paypal-transmission-sig") ?? "",
            transmission_time: headers.get("paypal-transmission-time") ?? "",
            webhook_id: webhookId,
          },
          rawEvent,
        ),
        redirect: "error",
        signal: AbortSignal.timeout(8000),
      },
    );
    if (res.status === 401) forgetToken();
    // A PayPal outage is not a forgery: 503 makes PayPal retry, 401 would not.
    if (couldNotCheck(res.status)) return { verified: null, detail: `could not check: verify http ${res.status}` };
    if (!res.ok) return { verified: false, detail: `verify http ${res.status}` };
    const out = (await res.json()) as { verification_status?: string };
    return {
      verified: out.verification_status === "SUCCESS",
      detail: out.verification_status ?? "no verification_status",
    };
  } catch (e) {
    // A timeout or a dropped connection says nothing about the signature.
    return { verified: null, detail: `could not check: verify threw ${(e as Error).name}` };
  }
}
