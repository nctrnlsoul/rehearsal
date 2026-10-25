import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { isIPv4, isIPv6 } from "node:net";
import type { ConsoleDb } from "./db";

/**
 * The judge gate (R-034). Pure functions plus one injectable attempt store, so
 * every rule here is tested without a server.
 *
 * Fail closed throughout: a missing or malformed passcode hash or session
 * secret keeps the gate shut, a blocked caller is refused before the passcode
 * is even hashed, and a session that cannot be verified is no session.
 */

type Env = Record<string, string | undefined>;

export const PASSCODE_HASH_VAR = "CONSOLE_PASSCODE_HASH";
export const SESSION_SECRET_VAR = "CONSOLE_SESSION_SECRET";
export const SESSION_COOKIE = "__Host-rehearsal_session";
export const SESSION_TTL_S = 2 * 60 * 60;
export const PASSCODE_MAX_CHARS = 256;
export const MIN_SECRET_CHARS = 32;

// Must match scripts/hash-passcode.mjs.
const SCRYPT_N = 16384;
const KEY_BYTES = 32;

export type PasscodeHash = { readonly salt: Buffer; readonly key: Buffer };

/** Reads "scrypt$<saltHex>$<keyHex>". Anything else is null, which keeps the gate closed. */
export function parsePasscodeHash(raw: string | undefined): PasscodeHash | null {
  const m = /^scrypt\$([0-9a-f]{32})\$([0-9a-f]{64})$/.exec(raw?.trim() ?? "");
  if (m === null) return null;
  return { salt: Buffer.from(m[1]!, "hex"), key: Buffer.from(m[2]!, "hex") };
}

export function verifyPasscode(input: string, hash: PasscodeHash): boolean {
  const derived = scryptSync(input, hash.salt, KEY_BYTES, { N: SCRYPT_N, r: 8, p: 1 });
  return timingSafeEqual(derived, hash.key);
}

export function sessionSecret(env: Env): string | null {
  const s = env[SESSION_SECRET_VAR];
  return s !== undefined && s.trim().length >= MIN_SECRET_CHARS ? s : null;
}

/**
 * The caller's address as Vercel reports it, and only as Vercel reports it.
 *
 * Vercel's request-headers docs: it overwrites X-Forwarded-For and does not
 * forward external values, and x-vercel-forwarded-for carries the same address
 * even where a proxy in front could rewrite X-Forwarded-For. So that is the one
 * header read here. X-Forwarded-For and X-Real-IP are never a fallback: off
 * Vercel, or if Vercel ever stopped setting its header, they are whatever the
 * client typed, and a fresh value per try would dodge the limit (audit
 * 2026-10-25 M2). With no usable value every such caller shares one bucket,
 * which can only make the lockout stricter.
 */
export function clientIp(headers: Headers): string {
  return limiterKey((headers.get("x-vercel-forwarded-for") ?? "").trim());
}

/**
 * The bucket one address counts against. IPv4 is the address itself. IPv6 is
 * its /64: one subscriber is routinely handed a whole /64, so counting each
 * full address gave one person 2^64 sets of tries (audit 2026-10-25 M2). An
 * IPv4 address mapped into IPv6 counts as the IPv4 address. Anything that is
 * not exactly one address is "unknown".
 */
export function limiterKey(raw: string): string {
  if (isIPv4(raw)) return raw;
  const addr = raw.split("%")[0]!;
  if (!isIPv6(addr)) return "unknown";
  const groups = expandIPv6(addr);
  if (groups === null) return "unknown";
  if (groups.slice(0, 6).join(":") === "0:0:0:0:0:65535") {
    return [groups[6]! >> 8, groups[6]! & 255, groups[7]! >> 8, groups[7]! & 255].join(".");
  }
  return `${groups.slice(0, 4).map((g) => g.toString(16)).join(":")}::/64`;
}

/** Eight 16-bit groups, or null. Takes "::" and a dotted IPv4 tail, which isIPv6 accepts. */
function expandIPv6(addr: string): number[] | null {
  const halves = addr.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string): number[] | null => {
    if (part === "") return [];
    const out: number[] = [];
    for (const g of part.split(":")) {
      if (g.includes(".")) {
        if (!isIPv4(g)) return null;
        const [a, b, c, d] = g.split(".").map(Number) as [number, number, number, number];
        out.push((a << 8) | b, (c << 8) | d);
      } else {
        if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
        out.push(parseInt(g, 16));
      }
    }
    return out;
  };
  const head = parse(halves[0]!);
  const tail = halves.length === 2 ? parse(halves[1]!) : [];
  if (head === null || tail === null) return null;
  const fill = 8 - head.length - tail.length;
  if (halves.length === 2 ? fill < 1 : fill !== 0) return null;
  return [...head, ...new Array<number>(fill).fill(0), ...tail];
}

export type LimiterConfig = {
  /** Wrong passcodes one address (IPv6: one /64) may send per window before it is locked out. */
  readonly perIp: number;
  /**
   * Wrong passcodes from all addresses together per window that count as an
   * attack in progress. Crossing it is logged; it refuses no one (R-036).
   */
  readonly global: number;
  readonly windowMs: number;
};

export const DEFAULT_LIMITS: LimiterConfig = { perIp: 5, global: 50, windowMs: 60 * 60 * 1000 };

export type LimitCheck =
  | { readonly allowed: true; readonly ipLeft: number }
  | { readonly allowed: false; readonly retryAfterS: number };

/**
 * Where passcode tries are counted. Shared by every server instance (R-038):
 * the counts live in the console's database, so a guesser cannot reset them by
 * landing on a fresh instance. The rules themselves are SQL, in
 * migrations/0003 (console_gate_take, console_gate_fail, console_gate_clear),
 * and only the caller's own count ever refuses anyone (R-036).
 *
 * A try takes its slot BEFORE the passcode is hashed, in one atomic call. A
 * separate check and count would let a burst of parallel guesses all read the
 * same count and all be hashed.
 *
 * Any method may throw when the database cannot be reached; the gate then
 * stays closed rather than letting a guess through uncounted.
 */
export type AttemptStore = {
  /** Takes one try for this address. When allowed, ipLeft is what remains after it. */
  take(bucket: string): Promise<LimitCheck>;
  /** Counts a wrong try toward the global ceiling. True on the one that reaches it, so the caller logs it once. */
  recordFailure(): Promise<boolean>;
  /** A correct passcode clears that address's count; it never lowers the global one. */
  recordSuccess(bucket: string): Promise<void>;
};

/**
 * The key a bucket is stored under: an HMAC under the session secret, so the
 * database never holds a caller's address. Each use gets its own label, so a
 * gate key can never equal a quota key for the same address.
 */
export function hashedKey(secret: string, label: "gate" | "ip" | "session", value: string): string {
  return createHmac("sha256", secret).update(`${label}:${value}`).digest("hex");
}

export function dbAttemptStore(
  db: ConsoleDb,
  secret: string,
  limits: LimiterConfig = DEFAULT_LIMITS,
): AttemptStore {
  const windowS = Math.round(limits.windowMs / 1000);
  const key = (bucket: string) => hashedKey(secret, "gate", bucket);
  return {
    async take(bucket) {
      const rows = await db.rpc("console_gate_take", { p_key: key(bucket), p_per_ip: limits.perIp, p_window_s: windowS });
      const row = Array.isArray(rows) ? (rows[0] as Record<string, unknown> | undefined) : undefined;
      // Anything but the exact shape is an unreadable answer, and an unreadable
      // answer about a lockout is never read as "allowed".
      if (row === undefined || typeof row["allowed"] !== "boolean") throw new Error("gate take returned an unreadable answer");
      if (row["allowed"] === true && typeof row["ip_left"] === "number") return { allowed: true, ipLeft: row["ip_left"] };
      if (row["allowed"] === false && typeof row["retry_after_s"] === "number") {
        return { allowed: false, retryAfterS: row["retry_after_s"] };
      }
      throw new Error("gate take returned an unreadable answer");
    },
    async recordFailure() {
      const hit = await db.rpc("console_gate_fail", { p_global: limits.global, p_window_s: windowS });
      if (typeof hit !== "boolean") throw new Error("gate failure count returned an unreadable answer");
      return hit;
    },
    async recordSuccess(bucket) {
      await db.rpc("console_gate_clear", { p_key: key(bucket) });
    },
  };
}

const b64url = (buf: Buffer) => buf.toString("base64url");
const mac = (secret: string, payload: string) => createHmac("sha256", secret).update(payload).digest();

/** "v1.<expiresAtSeconds>.<nonce>.<hmac>". The nonce makes every session token unique. */
export function signSession(secret: string, nowMs: number, ttlS: number = SESSION_TTL_S): string {
  const payload = `v1.${Math.floor(nowMs / 1000) + ttlS}.${b64url(randomBytes(12))}`;
  return `${payload}.${b64url(mac(secret, payload))}`;
}

export function verifySession(token: string | undefined, secret: string | null, nowMs: number): boolean {
  return verifiedSessionId(token, secret, nowMs) !== null;
}

/**
 * The signed part of a valid, unexpired session token ("v1.<expiry>.<nonce>"),
 * or null. It names one unlock of the gate, so it is what per-session quotas
 * are counted against (hashed before it is stored). Never the MAC.
 */
export function verifiedSessionId(token: string | undefined, secret: string | null, nowMs: number): string | null {
  if (secret === null || token === undefined || token.length > 200) return null;
  const m = /^(v1\.(\d{1,12})\.[A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (m === null) return null;
  // Compared as text, not decoded bytes: the 43rd character carries only 4
  // bits of the MAC, so decoding let a few different spellings of one MAC all
  // pass. Exactly one spelling is valid.
  const expected = Buffer.from(b64url(mac(secret, m[1]!)));
  const presented = Buffer.from(m[3]!);
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) return null;
  return Number(m[2]) * 1000 > nowMs ? m[1]! : null;
}

/** __Host- requires Secure, Path=/ and no Domain, so the cookie cannot be scoped wider or sent in clear. */
export function sessionCookieHeader(token: string, ttlS: number = SESSION_TTL_S): string {
  return `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${ttlS}; HttpOnly; Secure; SameSite=Strict`;
}

export function readCookie(header: string | null, name: string): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return rest.join("=");
  }
  return undefined;
}
