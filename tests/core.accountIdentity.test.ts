import { describe, expect, it } from "vitest";
import {
  type AccountIdentity,
  accountFingerprint,
  assertDistinctAccounts,
} from "../src/core/accountIdentity";

const SELLER_SUB = "https://www.paypal.com/webapps/auth/identity/user/AAAseller";
const BUYER_SUB = "https://www.paypal.com/webapps/auth/identity/user/BBBbuyer";

const id = (
  role: string,
  subject: string | null,
  appId: string | null = `APP-${role}`,
): AccountIdentity => ({ role, subject, appId });

describe("accountFingerprint", () => {
  it("is deterministic, short and hex", () => {
    const fp = accountFingerprint(SELLER_SUB);
    expect(fp).toBe(accountFingerprint(SELLER_SUB));
    expect(fp).toMatch(/^[0-9a-f]{12}$/);
  });

  it("differs per account and does not contain the subject", () => {
    expect(accountFingerprint(SELLER_SUB)).not.toBe(accountFingerprint(BUYER_SUB));
    expect(accountFingerprint(SELLER_SUB)).not.toContain("AAAseller");
  });

  it("ignores surrounding whitespace", () => {
    expect(accountFingerprint(`  ${SELLER_SUB}  `)).toBe(accountFingerprint(SELLER_SUB));
  });

  it("refuses a blank subject", () => {
    expect(() => accountFingerprint("   ")).toThrow();
  });
});

describe("assertDistinctAccounts", () => {
  it("passes when two apps sit on two accounts", () => {
    const v = assertDistinctAccounts([id("seller", SELLER_SUB), id("buyer", BUYER_SUB)]);
    expect(v.ok).toBe(true);
    expect(Object.keys(v.fingerprints).sort()).toEqual(["buyer", "seller"]);
  });

  // The exact failure that cost a wasted approval attempt.
  it("fails when both apps sit on the SAME account", () => {
    const v = assertDistinctAccounts([id("seller", SELLER_SUB), id("buyer", SELLER_SUB)]);
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/same sandbox account/i);
    expect(v.reason).toContain("seller");
    expect(v.reason).toContain("buyer");
  });

  it("treats subjects differing only by whitespace as the same account", () => {
    const v = assertDistinctAccounts([id("seller", SELLER_SUB), id("buyer", ` ${SELLER_SUB} `)]);
    expect(v.ok).toBe(false);
  });

  // Fail closed: an unreadable owner is not evidence of separation.
  it("fails when an owning account cannot be read", () => {
    for (const bad of [null, "", "   "]) {
      const v = assertDistinctAccounts([id("seller", SELLER_SUB), id("buyer", bad)]);
      expect(v.ok, JSON.stringify(bad)).toBe(false);
      expect(v.reason).toMatch(/refusing to assume/i);
    }
  });

  it("names every role whose owner could not be read", () => {
    const v = assertDistinctAccounts([id("seller", null), id("buyer", null)]);
    expect(v.ok).toBe(false);
    expect(v.reason).toContain("seller");
    expect(v.reason).toContain("buyer");
  });

  it("fails when the same app is used for both roles", () => {
    const v = assertDistinctAccounts([
      id("seller", SELLER_SUB, "APP-SAME"),
      id("buyer", BUYER_SUB, "APP-SAME"),
    ]);
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/same app/i);
  });

  it("fails when there is nothing to compare", () => {
    expect(assertDistinctAccounts([]).ok).toBe(false);
    expect(assertDistinctAccounts([id("seller", SELLER_SUB)]).ok).toBe(false);
  });

  it("exposes no raw subject in the verdict", () => {
    const v = assertDistinctAccounts([id("seller", SELLER_SUB), id("buyer", BUYER_SUB)]);
    const serialized = JSON.stringify(v);
    expect(serialized).not.toContain("AAAseller");
    expect(serialized).not.toContain("BBBbuyer");
  });
});
