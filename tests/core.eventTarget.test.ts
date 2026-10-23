import { describe, expect, it } from "vitest";
import {
  TargetRefusedError,
  assertAllowedEventTarget,
  assertWebhookHandlerTarget,
  normalizeOrigin,
  webhookHandlerUrl,
} from "../src/core/eventTarget";

const STORE = "https://rehearsal-store.vercel.app";

describe("normalizeOrigin", () => {
  it("drops the default port, path and case", () => {
    expect(normalizeOrigin("https://Rehearsal-Store.Vercel.App:443/hook?a=1")).toBe(STORE);
  });

  it("keeps a non-default port", () => {
    expect(normalizeOrigin("https://example.test:8443/x")).toBe("https://example.test:8443");
  });

  it("refuses http, userinfo and junk", () => {
    for (const bad of ["http://example.test", "https://u:p@example.test", "", "example.test", "/hook"]) {
      expect(() => normalizeOrigin(bad), JSON.stringify(bad)).toThrow(TargetRefusedError);
    }
  });
});

describe("assertAllowedEventTarget", () => {
  // The fail-open trap this whole function exists to prevent.
  it("refuses everything when the allowlist is empty", () => {
    expect(() => assertAllowedEventTarget(`${STORE}/hook`, [])).toThrow(TargetRefusedError);
  });

  it("accepts an exact origin match and preserves the path", () => {
    const u = assertAllowedEventTarget(`${STORE}/api/paypal/webhook`, [STORE]);
    expect(u.origin).toBe(STORE);
    expect(u.pathname).toBe("/api/paypal/webhook");
  });

  it("refuses a different host, a host that merely contains ours, and a port mismatch", () => {
    for (const bad of [
      "https://evil.test/hook",
      "https://rehearsal-store.vercel.app.evil.test/hook",
      "https://evil-rehearsal-store.vercel.app/hook",
      "https://rehearsal-store.vercel.app:8443/hook",
    ]) {
      expect(() => assertAllowedEventTarget(bad, [STORE]), bad).toThrow(TargetRefusedError);
    }
  });

  it("refuses rather than silently skipping a malformed allowlist entry", () => {
    expect(() => assertAllowedEventTarget(`${STORE}/hook`, [STORE, "http://oops.test"])).toThrow(
      TargetRefusedError,
    );
  });

  it("refuses a target that is allowlisted only over http", () => {
    expect(() => assertAllowedEventTarget("http://rehearsal-store.vercel.app/hook", [STORE])).toThrow(
      TargetRefusedError,
    );
  });
});

describe("assertWebhookHandlerTarget", () => {
  const HANDLER = `${STORE}/api/paypal/webhook`;

  it("accepts the exact handler URL of an allowlisted origin", () => {
    expect(assertWebhookHandlerTarget(HANDLER, [STORE]).toString()).toBe(HANDLER);
  });

  it("refuses the bare origin", () => {
    expect(() => assertWebhookHandlerTarget(STORE, [STORE])).toThrow(/must be exactly/);
  });

  it("still refuses an off-allowlist handler URL", () => {
    expect(() =>
      assertWebhookHandlerTarget("https://evil.test/api/paypal/webhook", [STORE]),
    ).toThrow(/not on the allowlist/);
  });

  it("builds the handler URL from a normalized origin", () => {
    expect(webhookHandlerUrl("https://Rehearsal-Store.vercel.app:443/")).toBe(HANDLER);
  });
});
