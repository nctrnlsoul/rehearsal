import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { middleware } from "../middleware";
import config from "../next.config";
import { contentSecurityPolicy, newNonce } from "../lib/csp";

/** Set once at the platform layer, so dropping one fails here. */
describe("security headers", () => {
  it("applies the fixed set to every path, and hides the framework", async () => {
    expect(config.poweredByHeader).toBe(false);
    const rules = await config.headers!();
    expect(rules).toHaveLength(1);
    expect(rules[0]!.source).toBe("/:path*");
    const h = Object.fromEntries(rules[0]!.headers.map((x) => [x.key, x.value]));
    expect(h["Strict-Transport-Security"]).toMatch(/max-age=\d{8,}/);
    expect(h["X-Frame-Options"]).toBe("DENY");
    expect(h["X-Content-Type-Options"]).toBe("nosniff");
    // no-referrer would make the gate's own form POST arrive with "Origin: null".
    expect(h["Referrer-Policy"]).toBe("same-origin");
    expect(h["Permissions-Policy"]).toContain("camera=()");
  });
});

describe("content security policy", () => {
  it("runs scripts only with this request's nonce, and never evals outside next dev", () => {
    const csp = contentSecurityPolicy("QUJDREVGR0hJSktMTU5PUA==", { dev: false });
    expect(csp).toContain("script-src 'self' 'nonce-QUJDREVGR0hJSktMTU5PUA==' 'strict-dynamic'");
    expect(csp).not.toContain("unsafe-eval");
    expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
    for (const d of ["default-src 'self'", "object-src 'none'", "base-uri 'none'", "frame-ancestors 'none'", "form-action 'self'"]) {
      expect(csp).toContain(d);
    }
    expect(contentSecurityPolicy("QUJDREVGR0hJSktMTU5PUA==", { dev: true })).toContain("'unsafe-eval'");
  });

  it("refuses a nonce that could break out of the header", () => {
    expect(() => contentSecurityPolicy("abc'; script-src *", { dev: false })).toThrow();
    expect(() => contentSecurityPolicy("short", { dev: false })).toThrow();
  });

  it("makes a fresh nonce each time", () => {
    expect(newNonce()).not.toBe(newNonce());
    expect(newNonce()).toMatch(/^[A-Za-z0-9+/=]{24}$/);
  });

  it("is set by middleware on the response, matching the nonce it hands the page", () => {
    const res = middleware(new NextRequest("https://console.example.test/runs"));
    const csp = res.headers.get("content-security-policy")!;
    expect(csp).toMatch(/'nonce-[A-Za-z0-9+/=]{24}'/);
    // Tests run with NODE_ENV=test, which must be strict: only "development" relaxes it.
    expect(csp).not.toContain("unsafe-eval");
    const forwarded = res.headers.get("x-middleware-request-x-nonce");
    expect(forwarded).not.toBeNull();
    expect(csp).toContain(`'nonce-${forwarded}'`);
  });
});
