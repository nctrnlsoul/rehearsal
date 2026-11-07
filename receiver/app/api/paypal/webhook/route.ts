import { readBodyCapped } from "../../../../lib/body";
import { checkCertUrl, checkTransmission, couldNotCheck, verifyRequestBody } from "../../../../lib/certUrl";
import { createLedger, readConfig } from "../../../../lib/ledger";
import { accessToken, forgetToken } from "../../../../lib/paypalToken";

/**
 * The webhook endpoint PayPal delivers to.
 *
 * It records the arrival durably and, when credentials are present, verifies the
 * signature against PayPal. Verification is the point REHEARSAL makes: events
 * from PayPal's own Webhook Simulator cannot be verified through the
 * verify-webhook-signature endpoint or resent (PayPal's webhook simulator docs),
 * so an app that verifies through that endpoint rejects them. Real events pass.
 *
 * If the ledger cannot be written, this returns a non-2xx on purpose. PayPal
 * retries, so a storage outage delays arrivals instead of losing them. Answering
 * 200 while dropping the row would be the worst of both.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = ["iad1"];
export const maxDuration = 15;

const SANDBOX_HOST = "api-m.sandbox.paypal.com";
const MAX_BODY_BYTES = 1_000_000;

/**
 * Longest id or type the ledger records. PayPal's are far shorter; anything
 * longer did not come from PayPal and is recorded as absent. Migration 0003
 * holds the same line in the database.
 */
const MAX_FIELD_CHARS = 128;
/** The detail is our own text, but it can quote a cert host of up to 253 characters. */
const MAX_DETAIL_CHARS = 300;

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" && v.length <= MAX_FIELD_CHARS ? v : null;
}

function detailOf(raw: string): string {
  const flat = raw.replace(/[\p{Cc}\p{Cf}]+/gu, " ").trim();
  return Array.from(flat).slice(0, MAX_DETAIL_CHARS).join("");
}

/** Every PayPal delivery carries these. Lacking any one, it is not a delivery. */
const REQUIRED_HEADERS = [
  "paypal-transmission-id",
  "paypal-transmission-time",
  "paypal-transmission-sig",
  "paypal-auth-algo",
  "paypal-cert-url",
] as const;

async function verify(
  headers: Headers,
  rawEvent: string,
): Promise<{ verified: boolean | null; detail: string }> {
  const clientId = process.env["PAYPAL_SELLER_CLIENT_ID"];
  const clientSecret = process.env["PAYPAL_SELLER_CLIENT_SECRET"];
  const webhookId = process.env["REHEARSAL_WEBHOOK_ID"];

  if (!clientId?.trim() || !clientSecret?.trim() || !webhookId?.trim()) {
    return { verified: null, detail: "receiver holds no credentials, verification not attempted" };
  }

  // Local checks first. The endpoint is public, so a request that cannot be
  // PayPal's must be refused before it costs a token call or a verify call.
  const missing = REQUIRED_HEADERS.filter((h) => (headers.get(h) ?? "").trim() === "");
  if (missing.length > 0) return { verified: false, detail: `missing ${missing.join(", ")}` };

  // cert_url arrives from the request and PayPal will fetch it. We do not fetch
  // it, but we refuse to forward anything but a PayPal cert URL.
  const cert = checkCertUrl(headers.get("paypal-cert-url") ?? "");
  if (!cert.ok) return { verified: false, detail: cert.detail };
  const transmission = checkTransmission(headers, Date.now());
  if (!transmission.ok) return { verified: false, detail: transmission.detail };

  try {
    const bearer = await accessToken(clientId, clientSecret, fetch);
    if (bearer === null) return { verified: null, detail: "could not check: no PayPal token" };

    const res = await fetch(`https://${SANDBOX_HOST}/v1/notifications/verify-webhook-signature`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${bearer}`,
        "Content-Type": "application/json",
      },
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
      signal: AbortSignal.timeout(8000),
    });
    if (res.status === 401) forgetToken();
    // A PayPal outage is not a forgery, so it is recorded as unchecked.
    if (couldNotCheck(res.status)) return { verified: null, detail: `could not check: verify http ${res.status}` };
    if (!res.ok) return { verified: false, detail: `verify http ${res.status}` };
    const out = (await res.json()) as { verification_status?: string };
    return {
      verified: out.verification_status === "SUCCESS",
      detail: out.verification_status ?? "no verification_status",
    };
  } catch (e) {
    // A timeout or a dropped connection says nothing about the signature.
    // Never leak provider detail to the caller; this string stays server-side.
    return { verified: null, detail: `could not check: verify threw ${(e as Error).name}` };
  }
}

export async function POST(req: Request): Promise<Response> {
  // Checked before any work: if there is nowhere to record the arrival, say so
  // rather than accepting a delivery we are going to drop.
  let config;
  try {
    config = readConfig(process.env);
  } catch (e) {
    console.error(`ledger misconfigured: ${(e as Error).message}`);
    return Response.json({ ok: false }, { status: 503 });
  }
  if (config === null) {
    console.error("ledger is not configured: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are unset");
    return Response.json({ ok: false }, { status: 503 });
  }

  const raw = await readBodyCapped(req, MAX_BODY_BYTES);
  if (raw === null) {
    return Response.json({ ok: false }, { status: 413 });
  }

  let event: unknown;
  try {
    event = JSON.parse(raw);
  } catch {
    return Response.json({ ok: false }, { status: 400 });
  }

  const e = (typeof event === "object" && event !== null ? event : {}) as Record<string, unknown>;
  const { verified, detail } = await verify(req.headers, raw);

  try {
    await createLedger(config).append({
      eventId: str(e["id"]),
      eventType: str(e["event_type"]),
      receivedAtMs: Date.now(),
      verified,
      verifyDetail: detailOf(detail),
      resourceId: str((e["resource"] as Record<string, unknown> | undefined)?.["id"]),
      transmissionId: str(req.headers.get("paypal-transmission-id")),
    });
  } catch (err) {
    console.error(`ledger insert failed: ${(err as Error).message}`);
    // Non-2xx so PayPal retries. Delayed beats lost.
    return Response.json({ ok: false }, { status: 500 });
  }

  // PayPal only needs a 2xx. Nothing about our state goes back over the wire.
  return Response.json({ ok: true }, { status: 200 });
}

export function GET(): Response {
  return Response.json({ error: "method not allowed" }, { status: 405 });
}
