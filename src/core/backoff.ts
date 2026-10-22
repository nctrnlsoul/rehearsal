/**
 * Retry and throttle policy. PayPal publishes no fixed rate limits, so the only
 * safe posture is to back off on every signal it does give and to treat anything
 * unrecognized as non-retryable.
 */

export type RetryPolicy = {
  /** Total attempts including the first. */
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
};

export const DEFAULT_POLICY: RetryPolicy = {
  maxAttempts: 5,
  baseDelayMs: 1000,
  maxDelayMs: 30_000,
};

export type RetryDecision = {
  readonly retry: boolean;
  readonly delayMs: number;
  readonly reason: string;
};

/** Status we use for "the request never got a response". */
export const TRANSPORT_FAILURE = 0;

const RETRYABLE = new Set([408, 429, 500, 502, 503, 504, TRANSPORT_FAILURE]);
const TERMINAL_CLIENT = new Set([400, 401, 403, 404, 405, 415, 422]);

export function parseRetryAfter(
  header: string | null | undefined,
  nowMs: number,
): number | null {
  if (header === null || header === undefined) return null;
  const raw = header.trim();
  if (raw === "") return null;

  if (/^\d+$/.test(raw)) return Number(raw) * 1000;

  // Only hand an HTTP-date to Date.parse. Its legacy fallback accepts things like
  // "1.5" and "-5" as dates, which would turn junk into a real delay.
  if (!/^[A-Za-z]{3,9},?\s/.test(raw)) return null;

  const at = Date.parse(raw);
  if (Number.isNaN(at)) return null;
  return Math.max(0, at - nowMs);
}

export function retryDecision(args: {
  /** 1-based index of the attempt that just finished. */
  attempt: number;
  /** HTTP status, or TRANSPORT_FAILURE when no response arrived. */
  status: number;
  retryAfter?: string | null;
  nowMs: number;
  rand?: () => number;
  policy?: RetryPolicy;
}): RetryDecision {
  const policy = args.policy ?? DEFAULT_POLICY;
  const rand = args.rand ?? Math.random;
  const { status, attempt } = args;

  const recognized =
    Number.isInteger(status) &&
    (status === TRANSPORT_FAILURE || (status >= 100 && status <= 599));
  if (!recognized) {
    return { retry: false, delayMs: 0, reason: `unrecognized status ${status}, failing closed` };
  }

  if (status >= 200 && status < 300) {
    return { retry: false, delayMs: 0, reason: "success" };
  }
  // A 409 means a previous attempt with this idempotency key already landed
  // somewhere. Replaying it cannot tell us what that attempt did.
  if (status === 409) {
    return { retry: false, delayMs: 0, reason: "idempotency conflict, stop and report" };
  }
  if (TERMINAL_CLIENT.has(status)) {
    return { retry: false, delayMs: 0, reason: `terminal client error ${status}` };
  }
  if (!RETRYABLE.has(status)) {
    return { retry: false, delayMs: 0, reason: `status ${status} is not on the retry list, failing closed` };
  }
  if (attempt >= policy.maxAttempts) {
    return { retry: false, delayMs: 0, reason: `attempt budget exhausted after ${attempt}` };
  }

  const explicit = parseRetryAfter(args.retryAfter, args.nowMs);
  if (explicit !== null) {
    return {
      retry: true,
      delayMs: Math.min(explicit, policy.maxDelayMs),
      reason: `status ${status}, honouring Retry-After`,
    };
  }

  // Equal jitter: half the window fixed, half random. Keeps a real floor under
  // the delay, which full jitter does not.
  const cap = Math.min(policy.baseDelayMs * 2 ** (attempt - 1), policy.maxDelayMs);
  const delayMs = Math.round(cap / 2 + rand() * (cap / 2));
  return { retry: true, delayMs, reason: `status ${status}, exponential backoff` };
}
