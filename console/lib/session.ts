import { SESSION_COOKIE, sessionSecret, verifySession } from "./gate";

/** True only for a cookie this server signed, unexpired, under the current secret. */
export function hasValidSession(
  cookieValue: string | undefined,
  env: Record<string, string | undefined>,
  nowMs: number,
): boolean {
  return verifySession(cookieValue, sessionSecret(env), nowMs);
}

export { SESSION_COOKIE };
