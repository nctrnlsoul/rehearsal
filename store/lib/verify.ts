const SANDBOX_HOST = "api-m.sandbox.paypal.com";

/**
 * Signature verification against PayPal.
 *
 * The store refuses to act on anything that does not verify, so this is an
 * authentication boundary rather than a diagnostic. A failure and an
 * inability to check are both reported, and both stop the event acting.
 *
 * The webhook id is discovered by asking PayPal which webhook points at this
 * app's own URL, so there is no chicken-and-egg where the store cannot verify
 * until someone pastes an id that only exists after the first run.
 */

export type VerifyResult = {
  /** true verified, false failed, null could not be attempted. */
  verified: boolean | null;
  detail: string;
};

let cachedWebhookId: string | null = null;

async function token(
  clientId: string,
  clientSecret: string,
  fetchImpl: typeof fetch,
): Promise<string | null> {
  const basic = Buffer.from(`${clientId}:${clientSecret}`, "utf8").toString("base64");
  const res = await fetchImpl(`https://${SANDBOX_HOST}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) return null;
  const body = (await res.json()) as { access_token?: string };
  return typeof body.access_token === "string" ? body.access_token : null;
}

/** The webhook PayPal has registered for this app's own origin. */
export async function resolveWebhookId(
  env: Record<string, string | undefined>,
  selfOrigin: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  const override = env["REHEARSAL_STORE_WEBHOOK_ID"];
  if (override !== undefined && override.trim() !== "") return override.trim();
  if (cachedWebhookId !== null) return cachedWebhookId;

  const clientId = env["PAYPAL_SELLER_CLIENT_ID"];
  const clientSecret = env["PAYPAL_SELLER_CLIENT_SECRET"];
  if (!clientId?.trim() || !clientSecret?.trim()) return null;

  const accessToken = await token(clientId, clientSecret, fetchImpl);
  if (accessToken === null) return null;

  const res = await fetchImpl(`https://${SANDBOX_HOST}/v1/notifications/webhooks`, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) return null;
  const body = (await res.json()) as { webhooks?: unknown };
  const list = Array.isArray(body.webhooks) ? body.webhooks : [];

  for (const entry of list) {
    if (typeof entry !== "object" || entry === null) continue;
    const rec = entry as Record<string, unknown>;
    const url = rec["url"];
    if (typeof url === "string" && url.startsWith(selfOrigin) && typeof rec["id"] === "string") {
      cachedWebhookId = rec["id"];
      return cachedWebhookId;
    }
  }
  return null;
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

  const webhookId = await resolveWebhookId(env, selfOrigin, fetchImpl);
  if (webhookId === null) {
    return { verified: null, detail: "no webhook is registered for this store's URL" };
  }

  const certUrl = headers.get("paypal-cert-url") ?? "";
  // cert_url arrives from the request and PayPal will fetch it. We do not fetch
  // it, but we refuse to forward a host that is not PayPal's.
  let certHost = "";
  try {
    certHost = new URL(certUrl).hostname;
  } catch {
    return { verified: false, detail: "paypal-cert-url is not a URL" };
  }
  if (certHost !== "api.paypal.com" && !certHost.endsWith(".paypal.com")) {
    return { verified: false, detail: `paypal-cert-url host ${certHost} is not paypal.com` };
  }

  try {
    const accessToken = await token(clientId, clientSecret, fetchImpl);
    if (accessToken === null) return { verified: null, detail: "could not get a PayPal token" };

    const res = await fetchImpl(
      `https://${SANDBOX_HOST}/v1/notifications/verify-webhook-signature`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
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
