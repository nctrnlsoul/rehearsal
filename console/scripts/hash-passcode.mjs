// Prints the value for CONSOLE_PASSCODE_HASH.
//
// The passcode is read from stdin, never from an argument, so it does not land
// in shell history. Only the hash is printed. Usage:
//   npm run hash-passcode
// then type or paste the passcode and press Enter.

import { randomBytes, scryptSync } from "node:crypto";
import { createInterface } from "node:readline";

// Must match lib/gate.ts.
const N = 16384;
const KEY_BYTES = 32;

const rl = createInterface({ input: process.stdin, terminal: false });
const line = await new Promise((resolve) => rl.once("line", resolve));
rl.close();

const passcode = String(line);
if (passcode.length < 16) {
  console.error("Use a passcode of at least 16 characters; it is the only thing between the internet and a live run.");
  process.exit(1);
}
const salt = randomBytes(16);
const key = scryptSync(passcode, salt, KEY_BYTES, { N, r: 8, p: 1 });
console.log(`scrypt$${salt.toString("hex")}$${key.toString("hex")}`);
