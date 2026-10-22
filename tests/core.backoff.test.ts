import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY, parseRetryAfter, retryDecision } from "../src/core/backoff";

const NOW = 1_700_000_000_000;
const half = () => 0.5;
const base = { attempt: 1, nowMs: NOW, rand: half } as const;

describe("parseRetryAfter", () => {
  it("reads integer seconds", () => {
    expect(parseRetryAfter("2", NOW)).toBe(2000);
    expect(parseRetryAfter("0", NOW)).toBe(0);
  });

  it("reads an HTTP date", () => {
    expect(parseRetryAfter(new Date(NOW + 5000).toUTCString(), NOW)).toBe(5000);
  });

  it("clamps a past HTTP date to zero rather than going negative", () => {
    expect(parseRetryAfter(new Date(NOW - 60_000).toUTCString(), NOW)).toBe(0);
  });

  it("returns null for absent or unusable values so the caller falls back", () => {
    for (const bad of [null, undefined, "", "   ", "soon", "-5", "1.5", "NaN"]) {
      expect(parseRetryAfter(bad, NOW), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe("retryDecision", () => {
  it("retries 429 and honours Retry-After", () => {
    const d = retryDecision({ ...base, status: 429, retryAfter: "3" });
    expect(d.retry).toBe(true);
    expect(d.delayMs).toBe(3000);
  });

  it("falls back to equal-jitter exponential when Retry-After is unusable", () => {
    // attempt 1: cap = base 1000. equal jitter = 500 + 0.5 * 500.
    expect(retryDecision({ ...base, status: 429, retryAfter: "later" }).delayMs).toBe(750);
    // attempt 3: cap = 1000 * 2^2 = 4000. equal jitter = 2000 + 0.5 * 2000.
    expect(retryDecision({ ...base, attempt: 3, status: 429 }).delayMs).toBe(3000);
  });

  it("never exceeds the policy ceiling, even on a huge Retry-After", () => {
    const d = retryDecision({ ...base, status: 429, retryAfter: "86400" });
    expect(d.delayMs).toBe(DEFAULT_POLICY.maxDelayMs);
  });

  it("retries 5xx, 408 and transport failures", () => {
    for (const status of [500, 502, 503, 504, 408, 0]) {
      expect(retryDecision({ ...base, status }).retry, String(status)).toBe(true);
    }
  });

  it("does not retry deterministic client errors", () => {
    for (const status of [400, 401, 403, 404, 422]) {
      expect(retryDecision({ ...base, status }).retry, String(status)).toBe(false);
    }
  });

  it("does not retry 409, because replaying an idempotency conflict proves nothing", () => {
    const d = retryDecision({ ...base, status: 409 });
    expect(d.retry).toBe(false);
    expect(d.reason).toMatch(/conflict/i);
  });

  it("does not retry success", () => {
    for (const status of [200, 201, 204]) {
      expect(retryDecision({ ...base, status }).retry, String(status)).toBe(false);
    }
  });

  it("stops once the attempt budget is spent", () => {
    const d = retryDecision({ ...base, attempt: DEFAULT_POLICY.maxAttempts, status: 429 });
    expect(d.retry).toBe(false);
    expect(d.reason).toMatch(/budget/i);
  });

  // Fail closed: an unrecognized status must not fall through to "retryable".
  it("refuses to retry an unrecognized status", () => {
    for (const status of [999, -1, 42, Number.NaN, 1.5, 600]) {
      const d = retryDecision({ ...base, status });
      expect(d.retry, String(status)).toBe(false);
      expect(d.reason, String(status)).toMatch(/closed/i);
    }
  });
});
