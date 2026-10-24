import { describe, expect, it } from "vitest";
import { PAYPAL_CERT_HOSTS, checkCertUrl } from "../lib/certUrl";

describe("checkCertUrl", () => {
  it("accepts https on the four PayPal API hosts", () => {
    for (const host of PAYPAL_CERT_HOSTS) {
      expect(checkCertUrl(`https://${host}/v1/notifications/certs/CERT-1`), host).toEqual({ ok: true });
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
