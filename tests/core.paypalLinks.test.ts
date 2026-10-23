import { describe, expect, it } from "vitest";
import { selfLinkId } from "../src/core/paypalLinks";

const DISPUTE_BODY = {
  links: [
    {
      href: "https://api-m.sandbox.paypal.com/v1/customer/disputes/PP-R-DXC-10194171",
      rel: "self",
      method: "GET",
    },
  ],
};

describe("selfLinkId", () => {
  // The exact body sandbox dispute creation returned on a 201.
  it("reads the id from a real dispute creation response", () => {
    expect(selfLinkId(DISPUTE_BODY)).toBe("PP-R-DXC-10194171");
  });

  it("picks the self link out of several", () => {
    const body = {
      links: [
        { href: "https://x.test/v1/a/UP-1", rel: "up", method: "GET" },
        { href: "https://x.test/v1/a/SELF-1", rel: "self", method: "GET" },
        { href: "https://x.test/v1/a/NEXT-1", rel: "next", method: "GET" },
      ],
    };
    expect(selfLinkId(body)).toBe("SELF-1");
  });

  it("tolerates a trailing slash and a query string", () => {
    expect(selfLinkId({ links: [{ rel: "self", href: "https://x.test/v1/d/ID-9/" }] })).toBe("ID-9");
    expect(selfLinkId({ links: [{ rel: "self", href: "https://x.test/v1/d/ID-9?x=1" }] })).toBe(
      "ID-9",
    );
  });

  it("decodes a percent-encoded segment", () => {
    expect(selfLinkId({ links: [{ rel: "self", href: "https://x.test/v1/d/A%2DB" }] })).toBe("A-B");
  });

  // Fail closed: return null rather than a wrong id, so the caller can report unknown.
  it("returns null for anything it cannot read", () => {
    for (const body of [
      null,
      undefined,
      {},
      [],
      "string",
      { links: "not-an-array" },
      { links: [] },
      { links: [{ rel: "up", href: "https://x.test/v1/d/ID-9" }] },
      { links: [{ rel: "self" }] },
      { links: [{ rel: "self", href: 42 }] },
      { links: [{ rel: "self", href: "not a url" }] },
      { links: [{ rel: "self", href: "https://x.test/" }] },
      { links: [{ rel: "self", href: "https://x.test" }] },
      { links: [null] },
    ]) {
      expect(selfLinkId(body), JSON.stringify(body) ?? "undefined").toBeNull();
    }
  });
});
