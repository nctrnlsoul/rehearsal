import { describe, expect, it } from "vitest";
import { errorSummary, pick, str } from "../src/core/json";

describe("str", () => {
  it("accepts a non-blank string and rejects everything else", () => {
    expect(str("x")).toBe("x");
    for (const bad of ["", "   ", null, undefined, 7, {}, []]) {
      expect(str(bad), JSON.stringify(bad) ?? "undefined").toBeNull();
    }
  });
});

describe("pick", () => {
  const body = {
    id: "ORD-1",
    purchase_units: [{ payments: { captures: [{ id: "CAP-1", status: "COMPLETED" }] } }],
  };

  it("reads a nested string through objects and arrays", () => {
    expect(pick(body, ["id"])).toBe("ORD-1");
    expect(pick(body, ["purchase_units", 0, "payments", "captures", 0, "id"])).toBe("CAP-1");
  });

  it("returns null for a wrong path rather than throwing", () => {
    expect(pick(body, ["nope"])).toBeNull();
    expect(pick(body, ["purchase_units", 9, "payments"])).toBeNull();
    expect(pick(body, ["id", "deeper"])).toBeNull();
    expect(pick(body, ["purchase_units", "payments"])).toBeNull();
    expect(pick(null, ["id"])).toBeNull();
  });
});

describe("errorSummary", () => {
  it("joins the fields PayPal actually uses", () => {
    const s = errorSummary(
      {
        name: "INVALID_REQUEST",
        message: "Request is not well-formed",
        details: [{ issue: "TRANSACTION_NOT_ELIGIBLE", description: "not eligible" }],
      },
      null,
    );
    expect(s).toContain("INVALID_REQUEST");
    expect(s).toContain("TRANSACTION_NOT_ELIGIBLE");
  });

  it("handles the oauth error shape", () => {
    expect(errorSummary({ error: "invalid_client", error_description: "bad creds" }, null)).toBe(
      "invalid_client | bad creds",
    );
  });

  // The raw body is saved with the run and served by the console, so a reply
  // that is not PayPal's error shape is never quoted, however it arrives.
  it("never quotes the raw body, and names the debug id instead", () => {
    expect(errorSummary({}, "f1a2b3c4d5e6")).toBe("no PayPal error name in the reply, debug id f1a2b3c4d5e6");
    expect(errorSummary(null, null)).toBe("no PayPal error name in the reply");
    expect(errorSummary({ debug_id: "abc123", email: "buyer@example.com" }, null)).toBe(
      "no PayPal error name in the reply, debug id abc123",
    );
    expect(errorSummary({}, "<html>proxy page</html>")).not.toContain("<");
  });

  it("keeps each named field printable and short", () => {
    const s = errorSummary({ name: "X\u0007\nY", message: "m".repeat(5000) }, null);
    expect(s).toBe(`X Y | ${"m".repeat(200)}`);
  });
});
