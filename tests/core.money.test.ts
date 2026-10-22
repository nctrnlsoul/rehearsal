import { describe, expect, it } from "vitest";
import { currencyExponent, fromMinor, splitPartial, toMinor } from "../src/core/money";

describe("currencyExponent", () => {
  it("knows the currencies we use", () => {
    expect(currencyExponent("USD")).toBe(2);
    expect(currencyExponent("JPY")).toBe(0);
  });

  // Assuming 2 would silently multiply a JPY amount by 100.
  it("refuses an unknown currency instead of assuming two decimals", () => {
    expect(() => currencyExponent("XYZ")).toThrow(/refusing to assume/i);
  });

  it("refuses a non-canonical code rather than normalizing it", () => {
    expect(() => currencyExponent("usd")).toThrow();
    expect(() => currencyExponent(" USD ")).toThrow();
  });
});

describe("toMinor", () => {
  it("parses plain decimal strings", () => {
    expect(toMinor("10.00", "USD")).toBe(1000n);
    expect(toMinor("10", "USD")).toBe(1000n);
    expect(toMinor("10.5", "USD")).toBe(1050n);
    expect(toMinor("0.05", "USD")).toBe(5n);
    expect(toMinor("1000", "JPY")).toBe(1000n);
  });

  it("stays exact past the float boundary", () => {
    expect(toMinor("0.10", "USD") + toMinor("0.20", "USD")).toBe(30n);
    expect(toMinor("99999999.99", "USD")).toBe(9999999999n);
  });

  // Rounding money without being asked is how a refund quietly stops matching.
  it("refuses more decimal places than the currency allows", () => {
    expect(() => toMinor("10.005", "USD")).toThrow(/decimal/i);
    expect(() => toMinor("10.00", "JPY")).toThrow(/decimal/i);
  });

  it("refuses anything that is not a plain unsigned decimal", () => {
    for (const bad of ["", " ", "-1.00", "+1.00", "1e2", "1,000.00", "10.", ".5", "abc", "Infinity", "NaN"]) {
      expect(() => toMinor(bad, "USD"), JSON.stringify(bad)).toThrow();
    }
  });
});

describe("fromMinor", () => {
  it("formats with exactly the currency's decimal places", () => {
    expect(fromMinor(1000n, "USD")).toBe("10.00");
    expect(fromMinor(5n, "USD")).toBe("0.05");
    expect(fromMinor(0n, "USD")).toBe("0.00");
    expect(fromMinor(1000n, "JPY")).toBe("1000");
  });

  it("refuses a negative amount", () => {
    expect(() => fromMinor(-1n, "USD")).toThrow(/negative/i);
  });

  it("round trips", () => {
    for (const v of ["0.01", "4.20", "42.00", "1234.56"]) {
      expect(fromMinor(toMinor(v, "USD"), "USD")).toBe(v);
    }
  });
});

describe("splitPartial", () => {
  it("splits by basis points and the parts always sum to the total", () => {
    const { refundMinor, remainingMinor } = splitPartial(4200n, 3500);
    expect(refundMinor).toBe(1470n);
    expect(remainingMinor).toBe(2730n);
    expect(refundMinor + remainingMinor).toBe(4200n);
  });

  it("floors rather than rounding up, so a refund never exceeds the capture", () => {
    expect(splitPartial(1001n, 3333).refundMinor).toBe(333n);
  });

  it("refuses a split that is not actually partial", () => {
    expect(() => splitPartial(1000n, 0)).toThrow();
    expect(() => splitPartial(1000n, 10_000)).toThrow();
    expect(() => splitPartial(1000n, 10_001)).toThrow();
  });

  it("refuses a split that rounds away to nothing", () => {
    expect(() => splitPartial(100n, 1)).toThrow(/zero/i);
  });

  it("refuses a non-positive total", () => {
    expect(() => splitPartial(0n, 5000)).toThrow();
    expect(() => splitPartial(-5n, 5000)).toThrow();
  });
});
