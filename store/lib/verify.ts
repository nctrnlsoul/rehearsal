const SANDBOX_HOST = "api-m.sandbox.paypal.com";

/**
 * Signature verification against PayPal. Optional: without credentials the store
 * records verified=null, which means "not attempted" rather than "failed".
 *
 * The store records the result instead of rejecting on failure, because the
 * verification state is itself something the edge-case finder reads.
 */
export async function verifySignature(
  headers: Headers,
  event: unknown,
  env: Record<string, string | undefined>,
): Promise<{ verified: boolean | null; detail: string }> {
  const clientId = env["PAYPAL_SELLER_CLIENT_ID"];
  const clientSecret = env["PAYPAL_SELLER_CLIENT_SECRET"];
  const webhookId = env["REHEARSAL_STORE_WEBHOOK_ID"];

  if (!clientId?.trim() || !clientSecret?.trim() || !webhookId?.trim()) {
    return { verified: null, detail: "store holds no credentials, verification not attempted" };
  }

  const certUrl = headers.get("paypal-cert-url") ?? "";
  // cert_url comes from the request and PayPal will fetch it. We do not fetch
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
    const basic = Buffer.from(`${clientId}:${clientSecret}`, "utf8").toString("base64");
    const tokenRes = await fetch(`https://${SANDBOX_HOST}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
      signal: AbortSignal.timeout(8000),
    });
    if (!tokenRes.ok) return { verified: false, detail: `token http ${tokenRes.status}` };
    const token = (await tokenRes.json()) as { access_token?: string };
    if (!token.access_token) return { verified: false, detail: "no access_token" };

    const res = await fetch(`https://${SANDBOX_HOST}/v1/notifications/verify-webhook-signature`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token.access_token}`,
        "Content-Type": "application/json",
      },
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
    });
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
