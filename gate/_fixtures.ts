/**
 * Gate-facing wrappers over the shared sandbox fixtures. The values themselves
 * now live in src/core/sandboxFixtures.ts so the executor can use them without
 * importing anything from gate/.
 */
import { cardOrderBody as coreCardOrderBody } from "../src/core/sandboxFixtures";

export { SANDBOX_CARD, unclaimedReceiver, walletOrderBody } from "../src/core/sandboxFixtures";

export const CURRENCY = "USD";

export function cardOrderBody(amount: string, reference: string) {
  return coreCardOrderBody(amount, CURRENCY, reference);
}
