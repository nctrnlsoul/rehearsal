import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { isIPv4, isIPv6 } from "node:net";

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

const MAX_TRACKED_IPS = 10_000;

export const DEFAULT_LIMITS: LimiterConfig = { perIp: 5, global: 50, windowMs: 60 * 60 * 1000 };

export type LimitCheck =
  | { readonly allowed: true; readonly ipLeft: number }
  | { readonly allowed: false; readonly retryAfterS: number };

/**
 * Counts wrong passcodes per address and in total, in fixed windows.
 *
 * Only the per-address count refuses anyone. The total used to close the gate
 * for everyone at its ceiling, so about 10 addresses could lock every judge
 * out for an hour. R-036: a correct passcode passes past the ceiling, and
 * failures keep counting. What bounds a many-address guesser now is the
 * per-address limit plus the Vercel WAF rate limit on POST /api/gate.
 *
 * Held in memory, so it counts per server instance. Stage A puts nothing of
 * value behind the gate, which makes that acceptable for now; Stage B moves the
 * counts to Supabase with the rest of the state, before live runs open.
 */
export class AttemptLimiter {
  readonly #cfg: LimiterConfig;
  readonly #now: () => number;
  readonly #byIp = new Map<string, { count: number; since: number }>();
  #global = { count: 0, since: 0 };

  constructor(cfg: LimiterConfig = DEFAULT_LIMITS, now: () => number = Date.now) {
    this.#cfg = cfg;
    this.#now = now;
  }

  /**
   * Expired entries go, so a flood of distinct addresses cannot grow memory
   * without bound. An address is stored only when it fails. Reaching this many
   * in one window means a flood far past the global ceiling; the WAF rate limit
   * is meant to stop that long before.
   */
  #prune(): void {
    if (this.#byIp.size < MAX_TRACKED_IPS) return;
    const now = this.#now();
    for (const [ip, e] of this.#byIp) if (now - e.since >= this.#cfg.windowMs) this.#byIp.delete(ip);
    // Still full means a live flood: forget the oldest, never refuse to count.
    while (this.#byIp.size >= MAX_TRACKED_IPS) this.#byIp.delete(this.#byIp.keys().next().value!);
  }

  #fresh(entry: { count: number; since: number }): { count: number; since: number } {
    return this.#now() - entry.since >= this.#cfg.windowMs ? { count: 0, since: this.#now() } : entry;
  }

  check(ip: string): LimitCheck {
    const now = this.#now();
    // Read only: an address is stored once it fails, not merely for asking.
    const mine = this.#fresh(this.#byIp.get(ip) ?? { count: 0, since: now });
    if (mine.count >= this.#cfg.perIp) {
      return { allowed: false, retryAfterS: Math.ceil((mine.since + this.#cfg.windowMs - now) / 1000) };
    }
    return { allowed: true, ipLeft: this.#cfg.perIp - mine.count };
  }

  /** True on the one failure that reaches the global ceiling, so the caller can log it once. */
  recordFailure(ip: string): boolean {
    const now = this.#now();
    this.#global = this.#fresh(this.#global);
    this.#global = { ...this.#global, count: this.#global.count + 1 };
    this.#prune();
    const mine = this.#fresh(this.#byIp.get(ip) ?? { count: 0, since: now });
    this.#byIp.set(ip, { ...mine, count: mine.count + 1 });
    return this.#global.count === this.#cfg.global;
  }

  /** Wrong passcodes from everyone in the current window. Read-only. */
  get globalFailures(): number {
    return this.#fresh(this.#global).count;
  }

  /** How many IPs are being counted. Read-only; exists so the memory bound is testable. */
  get trackedIps(): number {
    return this.#byIp.size;
  }

  /** A correct passcode clears that address's count; it never lowers the global one. */
  recordSuccess(ip: string): void {
    this.#byIp.delete(ip);
  }
}

const b64url = (buf: Buffer) => buf.toString("base64url");
const mac = (secret: string, payload: string) => createHmac("sha256", secret).update(payload).digest();

/** "v1.<expiresAtSeconds>.<nonce>.<hmac>". The nonce makes every session token unique. */
export function signSession(secret: string, nowMs: number, ttlS: number = SESSION_TTL_S): string {
  const payload = `v1.${Math.floor(nowMs / 1000) + ttlS}.${b64url(randomBytes(12))}`;
  return `${payload}.${b64url(mac(secret, payload))}`;
}

export function verifySession(token: string | undefined, secret: string | null, nowMs: number): boolean {
  if (secret === null || token === undefined || token.length > 200) return false;
  const m = /^(v1\.(\d{1,12})\.[A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (m === null) return false;
  const expected = mac(secret, m[1]!);
  const presented = Buffer.from(m[3]!, "base64url");
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) return false;
  return Number(m[2]) * 1000 > nowMs;
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
