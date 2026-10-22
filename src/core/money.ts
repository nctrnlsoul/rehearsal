/**
 * Money as integer minor units. PayPal sends and expects decimal strings, and a
 * partial refund has to reconcile against a capture to the cent, so no value in
 * this file ever becomes a float.
 */

const EXPONENTS = new Map<string, number>([
  ["USD", 2],
  ["EUR", 2],
  ["GBP", 2],
  ["CAD", 2],
  ["AUD", 2],
  ["JPY", 0],
]);

export function currencyExponent(code: string): number {
  const exp = EXPONENTS.get(code);
  if (exp === undefined) {
    throw new Error(
      `currency ${JSON.stringify(code)} has no known minor-unit exponent; refusing to assume 2`,
    );
  }
  return exp;
}

export function toMinor(value: string, currency: string): bigint {
  const exp = currencyExponent(currency);
  if (!/^\d+(\.\d+)?$/.test(value)) {
    throw new Error(`amount ${JSON.stringify(value)} is not a plain unsigned decimal string`);
  }
  const [whole, frac = ""] = value.split(".");
  if (frac.length > exp) {
    throw new Error(
      `amount ${value} has ${frac.length} decimal places but ${currency} allows ${exp}`,
    );
  }
  const scaled = (frac + "0".repeat(exp)).slice(0, exp);
  return BigInt(whole!) * 10n ** BigInt(exp) + BigInt(scaled === "" ? "0" : scaled);
}

export function fromMinor(minor: bigint, currency: string): string {
  const exp = currencyExponent(currency);
  if (minor < 0n) {
    throw new Error("amount cannot be negative");
  }
  if (exp === 0) return minor.toString();
  const divisor = 10n ** BigInt(exp);
  return `${minor / divisor}.${(minor % divisor).toString().padStart(exp, "0")}`;
}

/**
 * Splits a capture into a strictly partial refund and the remainder.
 * Basis points, not a percentage, so 35% is 3500 and no float is involved.
 */
export function splitPartial(
  totalMinor: bigint,
  basisPoints: number,
): { refundMinor: bigint; remainingMinor: bigint } {
  if (totalMinor <= 0n) {
    throw new Error("total must be positive");
  }
  if (!Number.isInteger(basisPoints) || basisPoints <= 0 || basisPoints >= 10_000) {
    throw new Error(`basisPoints must be an integer in 1..9999 for a partial refund, got ${basisPoints}`);
  }
  const refundMinor = (totalMinor * BigInt(basisPoints)) / 10_000n;
  if (refundMinor <= 0n) {
    throw new Error("refund rounds to zero at this total and split");
  }
  if (refundMinor >= totalMinor) {
    throw new Error("refund is not strictly less than the total");
  }
  return { refundMinor, remainingMinor: totalMinor - refundMinor };
}
