import { createHash } from "node:crypto";

/**
 * The PayPal access token, fetched once and reused until shortly before it
 * expires (audit 2026-10-25 M3). Without this, every request to the public
 * webhook cost a token call before anything else, so anyone could make the
 * receiver spend PayPal calls at the rate they could post. The store holds the
 * same code; the two deploy separately, so each carries its own copy.
 *
 * Held in memory per server instance. Concurrent requests on a cold instance
 * share one in-flight fetch rather than each starting their own.
 */

const SANDBOX_HOST = "api-m.sandbox.paypal.com";

/** Refetch this long before PayPal's stated expiry, so a token never expires mid-request. */
export const TOKEN_EXPIRY_MARGIN_S = 300;
/** Never trusted for longer than this, whatever PayPal says. PayPal's tokens last about 9 hours. */
const MAX_TOKEN_TTL_S = 8 * 60 * 60;

type Entry = { key: string; token: Promise<string | null>; expiresAtMs: number };

let cached: Entry | null = null;

/** The secret is part of the key, so a rotated secret never reuses the old token. Never stored raw. */
const keyOf = (clientId: string, clientSecret: string) =>
  createHash("sha256").update(`${clientId}\u0000${clientSecret}`, "utf8").digest("hex");

async function fetchToken(
  clientId: string,
  clientSecret: string,
  fetchImpl: typeof fetch,
): Promise<{ token: string; ttlS: number } | null> {
  const basic = Buffer.from(`${clientId}:${clientSecret}`, "utf8").toString("base64");
  const res = await fetchImpl(`https://${SANDBOX_HOST}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
    redirect: "error",
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) return null;
  const body = (await res.json()) as { access_token?: unknown; expires_in?: unknown };
  if (typeof body.access_token !== "string" || body.access_token === "") return null;
  const stated = typeof body.expires_in === "number" && Number.isFinite(body.expires_in) ? body.expires_in : 0;
  return { token: body.access_token, ttlS: Math.min(stated, MAX_TOKEN_TTL_S) - TOKEN_EXPIRY_MARGIN_S };
}

/** null when PayPal refused or the reply had no token; a thrown fetch propagates. */
export async function accessToken(
  clientId: string,
  clientSecret: string,
  fetchImpl: typeof fetch,
  now: () => number = Date.now,
): Promise<string | null> {
  const key = keyOf(clientId, clientSecret);
  if (cached !== null && cached.key === key && now() < cached.expiresAtMs) return cached.token;

  // Until the fetch settles, concurrent callers share it.
  const entry: Entry = { key, token: Promise.resolve(null), expiresAtMs: Number.POSITIVE_INFINITY };
  entry.token = fetchToken(clientId, clientSecret, fetchImpl).then(
    (got) => {
      // A failure, or a lifetime too short to be worth holding, is not cached.
      if (got === null || got.ttlS <= 0) {
        if (cached === entry) cached = null;
        return got?.token ?? null;
      }
      entry.expiresAtMs = now() + got.ttlS * 1000;
      return got.token;
    },
    (e: unknown) => {
      if (cached === entry) cached = null;
      throw e;
    },
  );
  cached = entry;
  return entry.token;
}

/**
 * Drops the held token. Called when PayPal answers 401 to a call made with it,
 * so a revoked token costs one failed request rather than eight hours of them.
 */
export function forgetToken(): void {
  cached = null;
}
