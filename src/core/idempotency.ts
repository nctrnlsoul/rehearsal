import { createHash } from "node:crypto";

/**
 * Idempotency keys for PayPal writes.
 *
 * Keys are DERIVED from a seed rather than random, so a retry of the same
 * logical operation presents the same PayPal-Request-Id and PayPal collapses it
 * instead of creating a second order, refund or payout. A random key per attempt
 * would make the header decorative.
 */

const NAMESPACE = "rehearsal:v1:";
/** ASCII unit separator: cannot appear in any seed part we build. */
const PART_SEPARATOR = "\u001f";

function requireSeed(seed: string): string {
  if (seed.trim() === "") {
    throw new Error("idempotency seed must be a non-blank string identifying the operation");
  }
  return seed;
}

function digest(seed: string): Buffer {
  return createHash("sha256").update(NAMESPACE + requireSeed(seed), "utf8").digest();
}

/** Stable UUID-shaped key for the PayPal-Request-Id header. */
export function requestId(seed: string): string {
  const h = digest(seed);
  // RFC 4122 section 4.3 name-based layout, so the value is a well-formed UUID
  // rather than a hex string that merely looks like one.
  h[6] = (h[6]! & 0x0f) | 0x50;
  h[8] = (h[8]! & 0x3f) | 0x80;
  const hex = h.subarray(0, 16).toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

/** Payouts caps sender_batch_id at 30 characters, so it gets its own shape. */
export function senderBatchId(seed: string): string {
  return `rhsl-${digest(seed).toString("hex").slice(0, 25)}`;
}

/** Builds a seed from parts. Separator-joined so ["ab","c"] and ["a","bc"] differ. */
export function seedOf(parts: readonly string[]): string {
  if (parts.length === 0) {
    throw new Error("idempotency seed must have at least one part");
  }
  for (const p of parts) {
    if (p.trim() === "") {
      throw new Error("idempotency seed parts must all be non-blank");
    }
    if (p.includes(PART_SEPARATOR)) {
      throw new Error("idempotency seed part must not contain the separator");
    }
  }
  return parts.join(PART_SEPARATOR);
}
