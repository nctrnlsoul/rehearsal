import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

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
 * The caller's IP as Vercel reports it. Vercel overwrites X-Forwarded-For with
 * the real client address and does not forward external values (its request
 * headers docs); x-vercel-forwarded-for is the same value, read first because a
 * proxy in front of Vercel could overwrite the other. With none present every
 * such caller shares one bucket, which can only make the lockout stricter.
 */
export function clientIp(headers: Headers): string {
  const first = (v: string | null) => (v ?? "").split(",")[0]!.trim();
  const ip = first(headers.get("x-vercel-forwarded-for")) || first(headers.get("x-real-ip")) || first(headers.get("x-forwarded-for"));
  return /^[0-9a-fA-F:.]{2,45}$/.test(ip) ? ip : "unknown";
}

export type LimiterConfig = {
  /** Wrong passcodes one IP may send per window before it is locked out. */
  readonly perIp: number;
  /** Wrong passcodes from all IPs together per window before the gate closes for everyone. */
  readonly global: number;
  readonly windowMs: number;
};

const MAX_TRACKED_IPS = 10_000;

export const DEFAULT_LIMITS: LimiterConfig = { perIp: 5, global: 50, windowMs: 60 * 60 * 1000 };

export type LimitCheck =
  | { readonly allowed: true; readonly ipLeft: number }
  | { readonly allowed: false; readonly reason: "ip" | "global"; readonly retryAfterS: number };

/**
 * Counts wrong passcodes per IP and in total, in fixed windows.
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
   * Expired entries go, so a flood of distinct IPs cannot grow memory without
   * bound. An IP is stored only when it fails, and the global ceiling closes the
   * gate long before this many could fail in one window at the default limits.
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
    this.#global = this.#fresh(this.#global);
    if (this.#global.count >= this.#cfg.global) {
      return { allowed: false, reason: "global", retryAfterS: Math.ceil((this.#global.since + this.#cfg.windowMs - now) / 1000) };
    }
    // Read only: an IP is stored once it fails, not merely for asking.
    const mine = this.#fresh(this.#byIp.get(ip) ?? { count: 0, since: now });
    if (mine.count >= this.#cfg.perIp) {
      return { allowed: false, reason: "ip", retryAfterS: Math.ceil((mine.since + this.#cfg.windowMs - now) / 1000) };
    }
    return { allowed: true, ipLeft: this.#cfg.perIp - mine.count };
  }

  recordFailure(ip: string): void {
    const now = this.#now();
    this.#global = this.#fresh(this.#global);
    this.#global = { ...this.#global, count: this.#global.count + 1 };
    this.#prune();
    const mine = this.#fresh(this.#byIp.get(ip) ?? { count: 0, since: now });
    this.#byIp.set(ip, { ...mine, count: mine.count + 1 });
  }

  /** How many IPs are being counted. Read-only; exists so the memory bound is testable. */
  get trackedIps(): number {
    return this.#byIp.size;
  }

  /** A correct passcode clears that IP's count; it never lowers the global one. */
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
