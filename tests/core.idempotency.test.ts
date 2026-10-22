import { describe, expect, it } from "vitest";
import { requestId, senderBatchId, seedOf } from "../src/core/idempotency";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("requestId", () => {
  it("is deterministic for the same seed, so a retry reuses the key", () => {
    expect(requestId("gate1:create-order")).toBe(requestId("gate1:create-order"));
  });

  it("differs for different seeds, so two writes never share a key", () => {
    expect(requestId("gate1:create-order")).not.toBe(requestId("gate1:create-order:2"));
    expect(requestId("gate2:refund")).not.toBe(requestId("gate3:payout"));
  });

  it("is a 36 character RFC 4122 name-based UUID", () => {
    const id = requestId("anything");
    expect(id).toHaveLength(36);
    expect(id).toMatch(UUID);
  });

  it("refuses an empty or blank seed", () => {
    // A blank seed means the caller forgot to identify the operation, which would
    // make two unrelated writes collide on one idempotency key.
    for (const bad of ["", "   ", "\t\n"]) {
      expect(() => requestId(bad), JSON.stringify(bad)).toThrow(/seed/i);
    }
  });

  it("does not leak the seed into the key", () => {
    expect(requestId("secret-looking-seed")).not.toContain("secret");
  });
});

describe("senderBatchId", () => {
  it("fits the 30 character payouts limit", () => {
    expect(senderBatchId("gate3:payout:run-1").length).toBeLessThanOrEqual(30);
  });

  it("uses only characters payouts accepts", () => {
    expect(senderBatchId("gate3:payout:run-1")).toMatch(/^[A-Za-z0-9-]+$/);
  });

  it("is deterministic and collision-distinct", () => {
    expect(senderBatchId("a")).toBe(senderBatchId("a"));
    expect(senderBatchId("a")).not.toBe(senderBatchId("b"));
  });

  it("refuses a blank seed", () => {
    expect(() => senderBatchId("  ")).toThrow(/seed/i);
  });
});

describe("seedOf", () => {
  it("joins parts without letting them collide across boundaries", () => {
    // ["ab","c"] and ["a","bc"] must not produce the same seed.
    expect(seedOf(["ab", "c"])).not.toBe(seedOf(["a", "bc"]));
  });

  it("is order sensitive", () => {
    expect(seedOf(["a", "b"])).not.toBe(seedOf(["b", "a"]));
  });

  it("refuses an empty list or a blank part", () => {
    expect(() => seedOf([])).toThrow(/seed/i);
    expect(() => seedOf(["a", ""])).toThrow(/seed/i);
  });
});
