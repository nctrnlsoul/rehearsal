import {
  type AttemptLimiter,
  PASSCODE_HASH_VAR,
  PASSCODE_MAX_CHARS,
  clientIp,
  parsePasscodeHash,
  sessionCookieHeader,
  sessionSecret,
  signSession,
  type PasscodeHash,
  verifyPasscode,
} from "./gate";

/**
 * POST /api/gate, as a function of its dependencies so every branch is tested.
 * The form posts here without JavaScript; every outcome is a 303 back to a
 * page, except a cross-site or oversized request, which gets a bare refusal.
 */

export type GateDeps = {
  readonly env: Record<string, string | undefined>;
  readonly limiter: AttemptLimiter;
  readonly now: () => number;
  /** Injected only so a test can prove which inputs ever reach the hash. */
  readonly verify?: (input: string, hash: PasscodeHash) => boolean;
};

export const MAX_BODY_BYTES = 2048;

const seeOther = (location: string, extra: Record<string, string> = {}) =>
  new Response(null, { status: 303, headers: { Location: location, "Cache-Control": "no-store", ...extra } });

export async function handleGatePost(req: Request, deps: GateDeps): Promise<Response> {
  // Same-origin only. A browser always sends Origin on a form POST, so a
  // missing one is not a browser on our page.
  const origin = req.headers.get("origin");
  const host = req.headers.get("host");
  let sameOrigin = false;
  try {
    sameOrigin = origin !== null && host !== null && new URL(origin).host === host;
  } catch {
    sameOrigin = false;
  }
  if (!sameOrigin) return new Response("forbidden", { status: 403 });

  const declared = Number(req.headers.get("content-length") ?? "0");
  if (!Number.isFinite(declared) || declared > MAX_BODY_BYTES) return new Response("too large", { status: 413 });
  const body = await req.text();
  if (body.length > MAX_BODY_BYTES) return new Response("too large", { status: 413 });

  const hash = parsePasscodeHash(deps.env[PASSCODE_HASH_VAR]);
  const secret = sessionSecret(deps.env);
  if (hash === null || secret === null) return seeOther("/gate?e=closed");

  // Refused before the passcode is hashed, so a locked-out caller costs no scrypt work.
  const ip = clientIp(req.headers);
  const check = deps.limiter.check(ip);
  if (!check.allowed) {
    const minutes = Math.max(1, Math.ceil(check.retryAfterS / 60));
    return seeOther(`/gate?e=${check.reason === "global" ? "busy" : "locked"}&m=${minutes}`);
  }

  const passcode = new URLSearchParams(body).get("passcode") ?? "";
  const verify = deps.verify ?? verifyPasscode;
  // Checked before hashing: scrypt never runs on an empty or oversized input.
  const ok = passcode !== "" && passcode.length <= PASSCODE_MAX_CHARS && verify(passcode, hash);
  if (!ok) {
    deps.limiter.recordFailure(ip);
    return seeOther(`/gate?e=wrong&left=${Math.max(0, check.ipLeft - 1)}`);
  }

  deps.limiter.recordSuccess(ip);
  return seeOther("/live", { "Set-Cookie": sessionCookieHeader(signSession(secret, deps.now())) });
}
