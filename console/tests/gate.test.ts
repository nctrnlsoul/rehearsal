import { describe, expect, it } from "vitest";
import {
  AttemptLimiter,
  SESSION_COOKIE,
  clientIp,
  parsePasscodeHash,
  readCookie,
  sessionCookieHeader,
  sessionSecret,
  signSession,
  verifyPasscode,
  verifySession,
} from "../lib/gate";
import { hashFor } from "./helpers";


const SECRET = "s".repeat(40);
const T0 = Date.parse("2026-10-24T12:00:00Z");

describe("passcode hash", () => {
  it("reads the scrypt format and nothing else", () => {
    expect(parsePasscodeHash(hashFor("correct horse battery"))).not.toBeNull();
    for (const bad of [undefined, "", "plaintext-passcode", "scrypt$zz$00", `sha256$${"a".repeat(32)}$${"b".repeat(64)}`, `scrypt$${"a".repeat(31)}$${"b".repeat(64)}`]) {
      expect(parsePasscodeHash(bad)).toBeNull();
    }
  });

  it("accepts the passcode it was made from and refuses any other", () => {
    const h = parsePasscodeHash(hashFor("correct horse battery"))!;
    expect(verifyPasscode("correct horse battery", h)).toBe(true);
    expect(verifyPasscode("correct horse batterY", h)).toBe(false);
    expect(verifyPasscode("", h)).toBe(false);
  });
});

describe("session secret", () => {
  it("needs at least 32 characters, or the gate stays closed", () => {
    expect(sessionSecret({ CONSOLE_SESSION_SECRET: "x".repeat(31) })).toBeNull();
    expect(sessionSecret({ CONSOLE_SESSION_SECRET: "  " })).toBeNull();
    expect(sessionSecret({})).toBeNull();
    expect(sessionSecret({ CONSOLE_SESSION_SECRET: SECRET })).toBe(SECRET);
  });
});

describe("clientIp", () => {
  it("prefers Vercel's own forwarded-for, then x-real-ip, then x-forwarded-for", () => {
    expect(clientIp(new Headers({ "x-vercel-forwarded-for": "203.0.113.7", "x-forwarded-for": "198.51.100.1" }))).toBe("203.0.113.7");
    expect(clientIp(new Headers({ "x-real-ip": "203.0.113.8", "x-forwarded-for": "198.51.100.1" }))).toBe("203.0.113.8");
    expect(clientIp(new Headers({ "x-forwarded-for": "198.51.100.1, 10.0.0.1" }))).toBe("198.51.100.1");
    expect(clientIp(new Headers({ "x-forwarded-for": "2001:db8::1" }))).toBe("2001:db8::1");
  });

  it("puts anything that is not an address in one shared bucket", () => {
    expect(clientIp(new Headers())).toBe("unknown");
    expect(clientIp(new Headers({ "x-forwarded-for": "<script>" }))).toBe("unknown");
    expect(clientIp(new Headers({ "x-vercel-forwarded-for": "a".repeat(60) }))).toBe("unknown");
  });
});

describe("AttemptLimiter", () => {
  const limits = { perIp: 5, global: 50, windowMs: 3_600_000 };

  it("locks one IP after 5 wrong tries, and only that IP", () => {
    let now = T0;
    const l = new AttemptLimiter(limits, () => now);
    for (let i = 0; i < 5; i += 1) {
      expect(l.check("203.0.113.1")).toMatchObject({ allowed: true, ipLeft: 5 - i });
      l.recordFailure("203.0.113.1");
    }
    expect(l.check("203.0.113.1")).toMatchObject({ allowed: false, reason: "ip" });
    expect(l.check("203.0.113.2")).toMatchObject({ allowed: true });
    now += 3_600_000;
    expect(l.check("203.0.113.1")).toMatchObject({ allowed: true, ipLeft: 5 });
  });

  it("closes for everyone once the global ceiling is reached", () => {
    const l = new AttemptLimiter(limits, () => T0);
    for (let i = 0; i < 50; i += 1) l.recordFailure(`198.51.100.${i}`);
    expect(l.check("203.0.113.99")).toMatchObject({ allowed: false, reason: "global" });
  });

  it("clears an IP on success but never lowers the global count", () => {
    const l = new AttemptLimiter({ ...limits, global: 6 }, () => T0);
    for (let i = 0; i < 4; i += 1) l.recordFailure("203.0.113.1");
    l.recordSuccess("203.0.113.1");
    expect(l.check("203.0.113.1")).toMatchObject({ allowed: true, ipLeft: 5 });
    l.recordFailure("203.0.113.2");
    l.recordFailure("203.0.113.2");
    expect(l.check("203.0.113.3")).toMatchObject({ allowed: false, reason: "global" });
  });

  it("keeps memory bounded under a flood of distinct IPs, and keeps counting", () => {
    // Only reachable with a huge global ceiling; at the default 50 the gate closes first.
    const l = new AttemptLimiter({ ...limits, global: 1_000_000 }, () => T0);
    for (let i = 0; i < 12_000; i += 1) l.recordFailure(`10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`);
    expect(l.trackedIps).toBeLessThanOrEqual(10_000);
    for (let i = 0; i < 5; i += 1) l.recordFailure("203.0.113.5");
    expect(l.check("203.0.113.5")).toMatchObject({ allowed: false, reason: "ip" });
  });

  it("only stores an IP once it fails, not for asking", () => {
    const l = new AttemptLimiter(limits, () => T0);
    for (let i = 0; i < 100; i += 1) l.check(`192.0.2.${i}`);
    expect(l.trackedIps).toBe(0);
  });
});

describe("session token", () => {
  it("verifies a token it signed until it expires", () => {
    const tok = signSession(SECRET, T0, 7200);
    expect(verifySession(tok, SECRET, T0 + 7_199_000)).toBe(true);
    expect(verifySession(tok, SECRET, T0 + 7_200_000)).toBe(false);
  });

  it("refuses a token signed with another secret, or none", () => {
    const tok = signSession(SECRET, T0);
    expect(verifySession(tok, "t".repeat(40), T0)).toBe(false);
    expect(verifySession(tok, null, T0)).toBe(false);
  });

  it("opens nothing when the secret is unset, even to a token signed with an empty key", () => {
    // If an unset secret ever fell back to "", anyone could sign a valid session.
    expect(verifySession(signSession("", T0), null, T0)).toBe(false);
  });

  it("refuses a token whose expiry or signature was edited", () => {
    const tok = signSession(SECRET, T0, 60);
    const [v, exp, nonce, mac] = tok.split(".");
    expect(verifySession(`${v}.${Number(exp) + 10_000}.${nonce}.${mac}`, SECRET, T0)).toBe(false);
    const flipped = mac!.slice(0, -1) + (mac!.endsWith("A") ? "B" : "A");
    expect(verifySession(`${v}.${exp}.${nonce}.${flipped}`, SECRET, T0)).toBe(false);
  });

  it("refuses anything that is not a token", () => {
    for (const bad of [undefined, "", "v1", "v1.1.2.3", "x".repeat(500)]) expect(verifySession(bad, SECRET, T0)).toBe(false);
  });

  it("makes every token unique", () => {
    expect(signSession(SECRET, T0)).not.toBe(signSession(SECRET, T0));
  });
});

describe("session cookie", () => {
  it("is __Host-, httpOnly, Secure, SameSite=Strict, whole-site and short-lived", () => {
    const c = sessionCookieHeader("tok", 7200);
    expect(c.startsWith(`${SESSION_COOKIE}=tok;`)).toBe(true);
    expect(SESSION_COOKIE.startsWith("__Host-")).toBe(true);
    for (const part of ["HttpOnly", "Secure", "SameSite=Strict", "Path=/", "Max-Age=7200"]) expect(c).toContain(part);
    expect(c).not.toMatch(/Domain=/i);
  });

  it("is read back by name only", () => {
    expect(readCookie(`a=1; ${SESSION_COOKIE}=v1.x.y.z; b=2`, SESSION_COOKIE)).toBe("v1.x.y.z");
    expect(readCookie(`not${SESSION_COOKIE}=evil`, SESSION_COOKIE)).toBeUndefined();
    expect(readCookie(null, SESSION_COOKIE)).toBeUndefined();
  });
});
