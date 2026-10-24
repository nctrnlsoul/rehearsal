import { describe, expect, it } from "vitest";
import config from "../next.config";

/** Set once at the platform layer, so dropping one from next.config fails here. */
describe("security headers", () => {
  it("applies the full set to every path, and hides the framework", async () => {
    expect(config.poweredByHeader).toBe(false);
    const rules = await config.headers!();
    expect(rules).toHaveLength(1);
    expect(rules[0]!.source).toBe("/:path*");
    const h = Object.fromEntries(rules[0]!.headers.map((x) => [x.key, x.value]));

    expect(h["Content-Security-Policy"]).toContain("default-src 'none'");
    expect(h["Content-Security-Policy"]).toContain("frame-ancestors 'none'");
    expect(h["Content-Security-Policy"]).not.toMatch(/script-src|unsafe-eval/);
    expect(h["Strict-Transport-Security"]).toMatch(/max-age=\d{8,}/);
    expect(h["X-Frame-Options"]).toBe("DENY");
    expect(h["X-Content-Type-Options"]).toBe("nosniff");
    expect(h["Referrer-Policy"]).toBe("no-referrer");
    expect(h["Permissions-Policy"]).toContain("camera=()");
  });
});
