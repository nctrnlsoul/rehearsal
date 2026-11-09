/**
 * How long a hosted run listens for PayPal's deliveries after its last step.
 * One rule in one place, with no engine import, so the worker that waits and
 * the page that shows the wait can never disagree.
 */

/** As the finder does. */
export const DELIVERY_WAIT_S = 90;

/**
 * Measured 2026-11-08: CUSTOMER.DISPUTE.CREATED arrived 3m04s and 3m21s after
 * filing, about 200 s after the dispute step ended, so a 90 s wait missed both.
 */
export const DISPUTE_DELIVERY_WAIT_S = 270;

/** The wait for a plan with these step kinds: longer when it files a dispute. */
export function deliveryWaitS(kinds: readonly string[]): number {
  return kinds.includes("open_dispute") ? DISPUTE_DELIVERY_WAIT_S : DELIVERY_WAIT_S;
}
