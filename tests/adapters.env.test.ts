import { describe, expect, it } from "vitest";
import {
  MissingCredentialError,
  credentialPresence,
  credentialsFor,
  optionalEnv,
  requiredEnv,
} from "../src/adapters/env";

const FULL = {
  PAYPAL_SELLER_CLIENT_ID: "seller-id",
  PAYPAL_SELLER_CLIENT_SECRET: "seller-secret",
  PAYPAL_BUYER_CLIENT_ID: "buyer-id",
  PAYPAL_BUYER_CLIENT_SECRET: "buyer-secret",
};

describe("requiredEnv", () => {
  it("returns a present value", () => {
    expect(requiredEnv("A", { A: "x" })).toBe("x");
  });

  it("refuses missing, empty and whitespace-only values", () => {
    for (const env of [{}, { A: "" }, { A: "   " }, { A: undefined }]) {
      expect(() => requiredEnv("A", env), JSON.stringify(env)).toThrow(MissingCredentialError);
    }
  });

  it("names the variable, not the value", () => {
    let caught: unknown;
    try {
      requiredEnv("PAYPAL_SELLER_CLIENT_SECRET", { PAYPAL_SELLER_CLIENT_SECRET: "  " });
    } catch (e) {
      caught = e;
    }
    const err = caught as MissingCredentialError;
    expect(err.message).toContain("PAYPAL_SELLER_CLIENT_SECRET");
    expect(err.variableName).toBe("PAYPAL_SELLER_CLIENT_SECRET");
  });
});

describe("optionalEnv", () => {
  it("returns null rather than an empty string", () => {
    expect(optionalEnv("A", { A: "" })).toBeNull();
    expect(optionalEnv("A", {})).toBeNull();
    expect(optionalEnv("A", { A: "x" })).toBe("x");
  });
});

describe("credentialsFor", () => {
  it("reads the documented variable names per role", () => {
    expect(credentialsFor("seller", FULL)).toEqual({
      clientId: "seller-id",
      clientSecret: "seller-secret",
    });
    expect(credentialsFor("buyer", FULL)).toEqual({
      clientId: "buyer-id",
      clientSecret: "buyer-secret",
    });
  });

  it("refuses when half a pair is set", () => {
    expect(() => credentialsFor("buyer", { PAYPAL_BUYER_CLIENT_ID: "x" })).toThrow(
      MissingCredentialError,
    );
  });
});

describe("credentialPresence", () => {
  it("reports booleans for all four variables and never a value", () => {
    const rows = credentialPresence({ ...FULL, PAYPAL_BUYER_CLIENT_SECRET: "" });
    expect(rows).toHaveLength(4);
    expect(rows.every((r) => typeof r.present === "boolean")).toBe(true);
    expect(JSON.stringify(rows)).not.toContain("seller-secret");
    expect(rows.find((r) => r.name === "PAYPAL_BUYER_CLIENT_SECRET")!.present).toBe(false);
  });
});
