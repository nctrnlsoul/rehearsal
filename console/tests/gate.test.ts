import { describe, expect, it } from "vitest";
import {
  SESSION_COOKIE,
  clientIp,
  hashedKey,
  limiterKey,
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
  it("reads Vercel's own header", () => {
    expect(clientIp(new Headers({ "x-vercel-forwarded-for": "203.0.113.7" }))).toBe("203.0.113.7");
  });

  // M2 (audit 2026-10-25): headers a client can set are never a fallback.
  it("never reads X-Forwarded-For or X-Real-IP, with or without Vercel's header", () => {
    expect(clientIp(new Headers({ "x-forwarded-for": "198.51.100.1" }))).toBe("unknown");
    expect(clientIp(new Headers({ "x-real-ip": "198.51.100.1" }))).toBe("unknown");
    expect(
      clientIp(new Headers({ "x-vercel-forwarded-for": "203.0.113.7", "x-forwarded-for": "198.51.100.1", "x-real-ip": "198.51.100.2" })),
    ).toBe("203.0.113.7");
  });

  it("puts anything that is not exactly one address in one shared bucket", () => {
    expect(clientIp(new Headers())).toBe("unknown");
    expect(clientIp(new Headers({ "x-vercel-forwarded-for": "<script>" }))).toBe("unknown");
    expect(clientIp(new Headers({ "x-vercel-forwarded-for": "a".repeat(60) }))).toBe("unknown");
    expect(clientIp(new Headers({ "x-vercel-forwarded-for": "198.51.100.1, 203.0.113.7" }))).toBe("unknown");
    expect(clientIp(new Headers({ "x-vercel-forwarded-for": "999.1.1.1" }))).toBe("unknown");
  });
});

describe("limiterKey counts IPv6 by /64 (M2)", () => {
  it("puts every address in one /64 in the same bucket", () => {
    const keys = ["2001:db8:1:2::1", "2001:db8:1:2:ffff:ffff:ffff:ffff", "2001:0DB8:0001:0002:0:0:0:9", "2001:db8:1:2::1%eth0"].map(limiterKey);
    expect(new Set(keys)).toEqual(new Set(["2001:db8:1:2::/64"]));
  });

  it("keeps neighboring /64s apart", () => {
    expect(limiterKey("2001:db8:1:3::1")).toBe("2001:db8:1:3::/64");
    expect(limiterKey("::1")).toBe("0:0:0:0::/64");
    expect(limiterKey("2001:db8::")).toBe("2001:db8:0:0::/64");
  });

  it("counts an IPv4 address mapped into IPv6 as the IPv4 address", () => {
    expect(limiterKey("::ffff:203.0.113.7")).toBe("203.0.113.7");
    expect(limiterKey("::ffff:cb00:7107")).toBe("203.0.113.7");
  });

  it("keeps IPv4 as the full address", () => {
    expect(limiterKey("203.0.113.7")).toBe("203.0.113.7");
  });

  it("refuses malformed IPv6", () => {
    for (const bad of ["2001:db8::1::2", "2001:db8:1:2:3:4:5:6:7", "2001:db8:::1", "gggg::1", ""]) {
      expect(limiterKey(bad), bad).toBe("unknown");
    }
  });
});

describe("hashedKey", () => {
  it("never contains the address, and differs by label and by secret", () => {
    const k = hashedKey(SECRET, "gate", "203.0.113.1");
    expect(k).toMatch(/^[0-9a-f]{64}$/);
    expect(k).not.toContain("203");
    expect(hashedKey(SECRET, "ip", "203.0.113.1")).not.toBe(k);
    expect(hashedKey("t".repeat(40), "gate", "203.0.113.1")).not.toBe(k);
    expect(hashedKey(SECRET, "gate", "203.0.113.1")).toBe(k);
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

describe("session token spelling", () => {
  // The MAC's last base64url character carries 4 real bits; its 2 spare bits
  // must not give one MAC several accepted spellings. Before the fix this
  // passed about 1 time in 16, whenever the MAC happened to end in A to D.
  it("accepts exactly one spelling of a MAC, for every token", () => {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    for (let i = 0; i < 200; i += 1) {
      const tok = signSession(SECRET, T0 + i * 1000, 60);
      const head = tok.slice(0, -1);
      const accepted = [...alphabet].filter((c) => verifySession(head + c, SECRET, T0));
      expect(accepted).toEqual([tok.slice(-1)]);
    }
  });
});
