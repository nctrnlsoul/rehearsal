import { accessToken, forgetToken } from "./paypalToken";

const SANDBOX_HOST = "api-m.sandbox.paypal.com";

/**
 * Signature verification against PayPal.
 *
 * The store refuses to act on anything that does not verify, so this is an
 * authentication boundary rather than a diagnostic. A failure and an
 * inability to check are both reported, and both stop the event acting.
 *
 * The webhook id is discovered by asking PayPal which webhook points at this
 * app's exact handler URL, so there is no chicken-and-egg where the store cannot verify
 * until someone pastes an id that only exists after the first run.
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

/** The cert URL's own checks, local and pure, so they run before any network call. */
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

export async function verifySignature(
  headers: Headers,
  event: unknown,
  env: Record<string, string | undefined>,
  selfOrigin: string,
  fetchImpl: typeof fetch = fetch,
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

  const certUrl = headers.get("paypal-cert-url") ?? "";
  // cert_url arrives from the request and PayPal will fetch it. We do not fetch
  // it, but we refuse to forward anything but a PayPal API URL.
  const cert = checkCertUrl(certUrl);
  if (!cert.ok) return { verified: false, detail: cert.detail };

  const resolved = await resolveWebhookId(env, selfOrigin, fetchImpl);
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
        body: JSON.stringify({
          auth_algo: headers.get("paypal-auth-algo"),
          cert_url: certUrl,
          transmission_id: headers.get("paypal-transmission-id"),
          transmission_sig: headers.get("paypal-transmission-sig"),
          transmission_time: headers.get("paypal-transmission-time"),
          webhook_id: webhookId,
          webhook_event: event,
        }),
        signal: AbortSignal.timeout(8000),
      },
    );
    if (res.status === 401) forgetToken();
    if (!res.ok) return { verified: false, detail: `verify http ${res.status}` };
    const out = (await res.json()) as { verification_status?: string };
    return {
      verified: out.verification_status === "SUCCESS",
      detail: out.verification_status ?? "no verification_status",
    };
  } catch (e) {
    return { verified: false, detail: `verify threw: ${(e as Error).name}` };
  }
}
