import { describe, expect, it } from "vitest";
import { classify, readStatus } from "../src/core/outcome";

const expectCompleted = { expect: ["COMPLETED"] } as const;

describe("readStatus", () => {
  it("reads a string status and normalizes case", () => {
    expect(readStatus({ status: "completed" })).toBe("COMPLETED");
  });

  it("returns null for anything that is not a string status", () => {
    for (const body of [null, undefined, {}, [], "COMPLETED", 7, { status: 7 }, { status: null }]) {
      expect(readStatus(body), JSON.stringify(body) ?? "undefined").toBeNull();
    }
  });
});

describe("classify", () => {
  it("calls the expected status a success", () => {
    const v = classify({ httpStatus: 201, body: { status: "COMPLETED" }, ...expectCompleted });
    expect(v.kind).toBe("success");
  });

  // The load-bearing fail-closed test: HTTP 2xx alone proves nothing happened.
  it("refuses to infer success from a 2xx with no status field", () => {
    const v = classify({ httpStatus: 201, body: {}, ...expectCompleted });
    expect(v.kind).toBe("unknown");
    expect(v.detail).toMatch(/no status/i);
  });

  it("treats a recognized but unexpected status as unknown, not as failure", () => {
    // PENDING on a capture is neither done nor refused. Stop and report.
    const v = classify({ httpStatus: 201, body: { status: "PENDING" }, ...expectCompleted });
    expect(v.kind).toBe("unknown");
  });

  it("treats a declared bad status as failure", () => {
    const v = classify({
      httpStatus: 201,
      body: { status: "DECLINED" },
      expect: ["COMPLETED"],
      knownFailed: ["DECLINED", "VOIDED"],
    });
    expect(v.kind).toBe("failed");
  });

  it("allows a bodyless 2xx only when the caller says the endpoint has no body", () => {
    expect(classify({ httpStatus: 204, body: null, expect: [] }).kind).toBe("unknown");
    expect(
      classify({ httpStatus: 204, body: null, expect: [], allowNoStatus: true }).kind,
    ).toBe("success");
  });

  it("treats deterministic client rejections as failure", () => {
    for (const httpStatus of [400, 401, 403, 404, 422, 429]) {
      const v = classify({ httpStatus, body: { name: "ERR" }, ...expectCompleted });
      expect(v.kind, String(httpStatus)).toBe("failed");
    }
  });

  // A 5xx on a write may or may not have executed. That is the definition of unknown.
  it("treats 5xx, 408 and 409 as unknown", () => {
    for (const httpStatus of [500, 502, 503, 504, 408, 409]) {
      const v = classify({ httpStatus, body: {}, ...expectCompleted });
      expect(v.kind, String(httpStatus)).toBe("unknown");
    }
  });

  it("treats an unrecognized http status as unknown", () => {
    for (const httpStatus of [0, 999, -1, Number.NaN]) {
      expect(classify({ httpStatus, body: {}, ...expectCompleted }).kind, String(httpStatus)).toBe(
        "unknown",
      );
    }
  });

  it("names the status it saw so a report can be acted on", () => {
    const v = classify({ httpStatus: 200, body: { status: "SAVED" }, ...expectCompleted });
    expect(v.detail).toContain("SAVED");
  });
});
