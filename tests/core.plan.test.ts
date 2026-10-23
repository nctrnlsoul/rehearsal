import { describe, expect, it } from "vitest";
import { topologicalOrder } from "../src/core/plan";

const n = (id: string, ...needs: string[]) => ({ id, needs });

describe("topologicalOrder", () => {
  it("orders a linear chain", () => {
    const r = topologicalOrder([n("c", "b"), n("b", "a"), n("a")]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.order).toEqual(["a", "b", "c"]);
  });

  it("orders a diamond with both middles before the join", () => {
    const r = topologicalOrder([n("a"), n("b", "a"), n("c", "a"), n("d", "b", "c")]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.order[0]).toBe("a");
      expect(r.order[3]).toBe("d");
      expect(r.order.slice(1, 3).sort()).toEqual(["b", "c"]);
    }
  });

  // Reproducible plans matter: the dry run must predict the real run exactly.
  it("keeps declaration order among independent steps, deterministically", () => {
    const nodes = [n("z"), n("m"), n("a")];
    const first = topologicalOrder(nodes);
    const second = topologicalOrder(nodes);
    expect(first.ok && first.order).toEqual(["z", "m", "a"]);
    expect(second.ok && second.order).toEqual(["z", "m", "a"]);
  });

  it("groups steps into waves that can run concurrently", () => {
    const r = topologicalOrder([n("a"), n("b", "a"), n("c", "a"), n("d", "b", "c")]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.waves[0]).toEqual(["a"]);
      expect(r.waves[1]!.sort()).toEqual(["b", "c"]);
      expect(r.waves[2]).toEqual(["d"]);
    }
  });

  it("accepts an empty plan", () => {
    const r = topologicalOrder([]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.order).toEqual([]);
  });

  it("rejects a duplicate id", () => {
    const r = topologicalOrder([n("a"), n("a")]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.map((e) => e.code)).toContain("duplicate-id");
  });

  it("rejects a dangling dependency and names it", () => {
    const r = topologicalOrder([n("a", "nope")]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors[0]!.code).toBe("dangling-dependency");
      expect(r.errors[0]!.message).toContain("nope");
    }
  });

  it("rejects a self dependency", () => {
    const r = topologicalOrder([n("a", "a")]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.map((e) => e.code)).toContain("self-dependency");
  });

  it("rejects a two step cycle and names both steps", () => {
    const r = topologicalOrder([n("a", "b"), n("b", "a")]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const cycle = r.errors.find((e) => e.code === "cycle");
      expect(cycle).toBeDefined();
      expect(cycle!.ids.sort()).toEqual(["a", "b"]);
    }
  });

  it("rejects a longer cycle while still ordering nothing", () => {
    const r = topologicalOrder([n("a"), n("b", "a", "d"), n("c", "b"), n("d", "c")]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const cycle = r.errors.find((e) => e.code === "cycle");
      expect(cycle!.ids.sort()).toEqual(["b", "c", "d"]);
    }
  });

  it("reports every problem at once rather than only the first", () => {
    const r = topologicalOrder([n("a", "ghost"), n("b", "phantom")]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.filter((e) => e.code === "dangling-dependency")).toHaveLength(2);
  });
});
