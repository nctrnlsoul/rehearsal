import { describe, expect, it } from "vitest";
import { PAYPAL_CERT_HOSTS, checkCertUrl, checkTransmission, couldNotCheck, verifyRequestBody } from "../lib/certUrl";

describe("checkCertUrl", () => {
  it("accepts https on the four PayPal API hosts, under PayPal's cert path, and hands back the parsed form", () => {
    for (const host of PAYPAL_CERT_HOSTS) {
      expect(checkCertUrl(`https://${host}/v1/notifications/certs/CERT-1`), host).toEqual({
        ok: true,
        href: `https://${host}/v1/notifications/certs/CERT-1`,
      });
    }
    expect(checkCertUrl("https://API.sandbox.paypal.com/v1/notifications/certs/C")).toEqual({
      ok: true,
      href: "https://api.sandbox.paypal.com/v1/notifications/certs/C",
    });
  });

  // The URL is forwarded to PayPal, which fetches it. Only the parsed form
  // leaves the app, and only a cert path on a pinned host.
  it("refuses a backslash, any other path, a query, and a dot-segment way out of the cert path", () => {
    const bs = String.fromCharCode(92);
    expect(checkCertUrl(`https://api.sandbox.paypal.com/v1/notifications/certs/C${bs}x`)).toEqual({
      ok: false,
      detail: "paypal-cert-url contains a backslash",
    });
    for (const bad of [
      "https://api.sandbox.paypal.com/v1/oauth2/token",
      "https://api.sandbox.paypal.com/v1/notifications/certs/../../oauth2/token",
      "https://api.sandbox.paypal.com/v1/notifications/certs/C?x=1",
      "https://api.sandbox.paypal.com/c",
    ]) {
      expect(checkCertUrl(bad), bad).toEqual({ ok: false, detail: "paypal-cert-url is not under PayPal's cert path" });
    }
  });

  it("requires https", () => {
    expect(checkCertUrl("http://api.sandbox.paypal.com/c")).toEqual({
      ok: false,
      detail: "paypal-cert-url is not https",
    });
  });

  // The old check let any *.paypal.com through, a far wider set than the API.
  it("refuses any other paypal.com host, and every look-alike", () => {
    for (const bad of [
      "https://www.paypal.com/c",
      "https://evil.paypal.com/c",
      "https://api.sandbox.paypal.com.evil.test/c",
      "https://evilpaypal.com/c",
      "https://api.paypal.com./c",
    ]) {
      expect(checkCertUrl(bad), bad).toMatchObject({ ok: false });
    }
  });

  it("refuses credentials, a port, and anything unparseable", () => {
    expect(checkCertUrl("https://evil@api.paypal.com/c")).toMatchObject({ ok: false });
    expect(checkCertUrl("https://api.paypal.com:8443/c")).toMatchObject({ ok: false });
    for (const bad of ["", "not a url", "//api.paypal.com/c"]) {
      expect(checkCertUrl(bad), bad).toMatchObject({ ok: false });
    }
  });
});

describe("checkTransmission", () => {
  const NOW = Date.parse("2026-11-07T12:00:00Z");
  const h = (over: Record<string, string> = {}) =>
    new Headers({
      "paypal-auth-algo": "SHA256withRSA",
      "paypal-transmission-id": "69cd13f0-d67a-11e5-baa3-778b53f4ae55",
      "paypal-transmission-time": new Date(NOW).toISOString(),
      ...over,
    });

  it("accepts PayPal's algorithm, an id of its shape, and a time within 10 minutes either way", () => {
    expect(checkTransmission(h(), NOW)).toEqual({ ok: true });
    expect(checkTransmission(h({ "paypal-transmission-time": new Date(NOW - 599_000).toISOString() }), NOW).ok).toBe(true);
    expect(checkTransmission(h({ "paypal-transmission-time": new Date(NOW + 599_000).toISOString() }), NOW).ok).toBe(true);
  });

  it("refuses any other algorithm, a junk id, and a stale, future or unreadable time", () => {
    const cases: Record<string, string>[] = [
      { "paypal-auth-algo": "SHA1withRSA" },
      { "paypal-transmission-id": "x" },
      { "paypal-transmission-id": "a b c d e f g h" },
      { "paypal-transmission-time": new Date(NOW - 601_000).toISOString() },
      { "paypal-transmission-time": new Date(NOW + 601_000).toISOString() },
      { "paypal-transmission-time": "soon" },
    ];
    for (const over of cases) expect(checkTransmission(h(over), NOW).ok, JSON.stringify(over)).toBe(false);
  });
});

describe("verifyRequestBody", () => {
  // PayPal signed the bytes it sent; a re-serialized copy can differ.
  it("carries the delivery byte for byte and stays valid JSON", () => {
    const bs = String.fromCharCode(92);
    const raw = `{"id":"WH-1","summary":"caf${bs}u00e9 ${bs}/ x","amount":1.50}`;
    const body = verifyRequestBody({ auth_algo: "SHA256withRSA", webhook_id: "WH" }, raw);
    expect(body.endsWith(`"webhook_event":${raw}}`)).toBe(true);
    expect(JSON.parse(body)).toMatchObject({ auth_algo: "SHA256withRSA", webhook_id: "WH" });
  });
});

describe("couldNotCheck", () => {
  it("reads an outage, a lost token or a rate limit as unchecked, and a refusal as a refusal", () => {
    for (const s of [401, 408, 429, 500, 502, 503]) expect(couldNotCheck(s), String(s)).toBe(true);
    for (const s of [400, 403, 404, 422]) expect(couldNotCheck(s), String(s)).toBe(false);
  });
});
