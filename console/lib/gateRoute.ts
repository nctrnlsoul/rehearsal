import {
  type AttemptStore,
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
 * The form posts here without JavaScript, so every outcome, refusals included,
 * is a 303 back to a page: a browser that lands here must never be left on a
 * bare response.
 */

export type GateDeps = {
  readonly env: Record<string, string | undefined>;
  /** Where wrong tries are counted. Null when the console has no database: the gate then stays shut. */
  readonly attempts: AttemptStore | null;
  readonly now: () => number;
  /** Injected only so a test can prove which inputs ever reach the hash. */
  readonly verify?: (input: string, hash: PasscodeHash) => boolean;
};

export const MAX_BODY_BYTES = 2048;

// A chunked upload carries no Content-Length, so the cap is enforced on the
// bytes as they arrive; the rest of the stream is never read into memory.
async function readCapped(req: Request, max: number): Promise<string | null> {
  if (req.body === null) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

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
  // One generic reason for both refusals: neither reaches the limiter or the hash.
  if (!sameOrigin) return seeOther("/gate?e=refused");

  const declared = Number(req.headers.get("content-length") ?? "0");
  if (!Number.isFinite(declared) || declared > MAX_BODY_BYTES) return seeOther("/gate?e=refused");
  const body = await readCapped(req, MAX_BODY_BYTES);
  if (body === null) return seeOther("/gate?e=refused");

  const hash = parsePasscodeHash(deps.env[PASSCODE_HASH_VAR]);
  const secret = sessionSecret(deps.env);
  if (hash === null || secret === null) return seeOther("/gate?e=closed");

  // No counter means no lockout, so the gate stays shut rather than taking
  // guesses it cannot count (R-038).
  const attempts = deps.attempts;
  if (attempts === null) return seeOther("/gate?e=unavailable");

  // Refused before the passcode is hashed, so a locked-out caller costs no
  // scrypt work. Only the caller's own count refuses: past the global ceiling
  // the right passcode still opens the gate (R-036).
  const ip = clientIp(req.headers);
  let check;
  try {
    check = await attempts.check(ip);
  } catch (e) {
    console.error(`gate: attempt count unreadable (${e instanceof Error ? e.name : "error"})`);
    return seeOther("/gate?e=unavailable");
  }
  if (!check.allowed) {
    const minutes = Math.max(1, Math.ceil(check.retryAfterS / 60));
    return seeOther(`/gate?e=locked&m=${minutes}`);
  }

  const passcode = new URLSearchParams(body).get("passcode") ?? "";
  const verify = deps.verify ?? verifyPasscode;
  // Checked before hashing: scrypt never runs on an empty or oversized input.
  const ok = passcode !== "" && passcode.length <= PASSCODE_MAX_CHARS && verify(passcode, hash);
  if (!ok) {
    try {
      if (await attempts.recordFailure(ip)) {
        console.warn("gate: wrong passcodes from all addresses reached the global ceiling this window");
      }
    } catch (e) {
      // The try went uncounted, so the caller is not told how many are left.
      console.error(`gate: wrong try could not be counted (${e instanceof Error ? e.name : "error"})`);
      return seeOther("/gate?e=unavailable");
    }
    return seeOther(`/gate?e=wrong&left=${Math.max(0, check.ipLeft - 1)}`);
  }

  try {
    await attempts.recordSuccess(ip);
  } catch (e) {
    // The passcode was right; a stale count only means fewer tries later, never more.
    console.error(`gate: count could not be cleared (${e instanceof Error ? e.name : "error"})`);
  }
  return seeOther("/live", { "Set-Cookie": sessionCookieHeader(signSession(secret, deps.now())) });
}
