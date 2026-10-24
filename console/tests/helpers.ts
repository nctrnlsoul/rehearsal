import { randomBytes, scryptSync } from "node:crypto";

/** A CONSOLE_PASSCODE_HASH value for a test passcode, made the way scripts/hash-passcode.mjs makes one. */
export function hashFor(passcode: string): string {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString("hex")}$${scryptSync(passcode, salt, 32, { N: 16384, r: 8, p: 1 }).toString("hex")}`;
}
