import { append } from "../../../../lib/ledger";

/**
 * The webhook endpoint PayPal delivers to.
 *
 * It records the arrival and, when credentials are present, verifies the
 * signature against PayPal. Verification is the point REHEARSAL makes: events
 * from PayPal's own Webhook Simulator cannot be verified, resent or looked up,
 * so an app that correctly verifies signatures rejects them. Real events pass.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Pinned so the five gate events are far more likely to land on one instance.
export const preferredRegion = ["iad1"];
export const maxDuration = 15;

const SANDBOX_HOST = "api-m.sandbox.paypal.com";
const MAX_BODY_BYTES = 1_000_000;

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

async function verify(
  headers: Headers,
  event: unknown,
): Promise<{ verified: boolean | null; detail: string }> {
  const clientId = process.env["PAYPAL_SELLER_CLIENT_ID"];
  const clientSecret = process.env["PAYPAL_SELLER_CLIENT_SECRET"];
  const webhookId = process.env["REHEARSAL_WEBHOOK_ID"];

  if (!clientId?.trim() || !clientSecret?.trim() || !webhookId?.trim()) {
    return { verified: null, detail: "receiver holds no credentials, verification not attempted" };
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
    // Never leak provider detail to the caller; this string stays server-side.
    return { verified: false, detail: `verify threw: ${(e as Error).name}` };
  }
}

export async function POST(req: Request): Promise<Response> {
  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) {
    return Response.json({ ok: false }, { status: 413 });
  }

  let event: unknown;
  try {
    event = JSON.parse(raw);
  } catch {
    return Response.json({ ok: false }, { status: 400 });
  }

  const e = (typeof event === "object" && event !== null ? event : {}) as Record<string, unknown>;
  const { verified, detail } = await verify(req.headers, event);

  append({
    eventId: str(e["id"]),
    eventType: str(e["event_type"]),
    receivedAtMs: Date.now(),
    verified,
    verifyDetail: detail,
    resourceId: str((e["resource"] as Record<string, unknown> | undefined)?.["id"]),
    transmissionId: req.headers.get("paypal-transmission-id"),
  });

  // PayPal only needs a 2xx. Nothing about our state goes back over the wire.
  return Response.json({ ok: true }, { status: 200 });
}

export function GET(): Response {
  return Response.json({ error: "method not allowed" }, { status: 405 });
}
