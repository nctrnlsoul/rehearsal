import { describe, expect, it } from "vitest";
import { MAX_STEPS, validateScenario } from "../src/core/scenario";

const STORE = "https://receiver-lyart.vercel.app";
const OPTS = { allowedEventOrigins: [STORE] };

const base = () => ({
  version: 1,
  name: "test scenario",
  profile: { name: "Test Shop" },
  currency: "USD",
  steps: [{ id: "order1", kind: "card_order", amount: "42.00" }],
});

const errorsFor = (mutate: (s: Record<string, unknown>) => void, opts = OPTS) => {
  const s = base() as Record<string, unknown>;
  mutate(s);
  const r = validateScenario(s, opts);
  return r.ok ? [] : r.errors;
};

describe("validateScenario, the happy path and defaults", () => {
  it("accepts a minimal scenario", () => {
    const r = validateScenario(base(), OPTS);
    expect(r.ok).toBe(true);
  });

  it("applies documented defaults", () => {
    const r = validateScenario(base(), OPTS);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.scenario.steps[0]!.needs).toEqual([]);
    expect(r.scenario.profile.country).toBe("US");
  });

  it("defaults a dispute reason and a payout item to claimed", () => {
    const r = validateScenario(
      {
        ...base(),
        steps: [
          { id: "d1", kind: "open_dispute" },
          { id: "p1", kind: "payout_batch", items: [{ amount: "5.00" }] },
        ],
      },
      OPTS,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const dispute = r.scenario.steps[0]!;
    const payout = r.scenario.steps[1]!;
    expect(dispute.kind === "open_dispute" && dispute.reason).toBe(
      "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
    );
    expect(payout.kind === "payout_batch" && payout.items[0]!.unclaimed).toBe(false);
  });
});

describe("validateScenario rejects bad step kinds and shapes", () => {
  it("rejects an unknown step kind", () => {
    const errs = errorsFor((s) => {
      s["steps"] = [{ id: "x", kind: "wire_transfer", amount: "1.00" }];
    });
    expect(errs.length).toBeGreaterThan(0);
    expect(errs.join(" ")).toMatch(/kind/i);
  });

  it("rejects a malformed step id", () => {
    for (const id of ["Order1", "order 1", "", "-order", "a".repeat(41), "órder"]) {
      const errs = errorsFor((s) => {
        s["steps"] = [{ id, kind: "card_order", amount: "1.00" }];
      });
      expect(errs.length, JSON.stringify(id)).toBeGreaterThan(0);
    }
  });

  it("rejects an empty step list", () => {
    expect(errorsFor((s) => { s["steps"] = []; }).length).toBeGreaterThan(0);
  });

  it(`rejects more than ${MAX_STEPS} steps`, () => {
    const errs = errorsFor((s) => {
      s["steps"] = Array.from({ length: MAX_STEPS + 1 }, (_, i) => ({
        id: `s${i}`,
        kind: "card_order",
        amount: "1.00",
      }));
    });
    expect(errs.join(" ")).toMatch(new RegExp(String(MAX_STEPS)));
  });

  it(`accepts exactly ${MAX_STEPS} steps`, () => {
    const r = validateScenario(
      {
        ...base(),
        steps: Array.from({ length: MAX_STEPS }, (_, i) => ({
          id: `s${i}`,
          kind: "card_order",
          amount: "1.00",
        })),
      },
      OPTS,
    );
    expect(r.ok).toBe(true);
  });
});

describe("validateScenario rejects float and malformed amounts", () => {
  // The headline money rule: a JSON number cannot hold cents exactly.
  it("rejects a numeric amount and says why", () => {
    const errs = errorsFor((s) => {
      s["steps"] = [{ id: "o", kind: "card_order", amount: 42.0 }];
    });
    expect(errs.join(" ")).toMatch(/decimal string/i);
  });

  it("rejects a numeric amount inside a payout item", () => {
    const errs = errorsFor((s) => {
      s["steps"] = [{ id: "p", kind: "payout_batch", items: [{ amount: 5.5 }] }];
    });
    expect(errs.length).toBeGreaterThan(0);
  });

  it("rejects more decimal places than the currency allows", () => {
    const errs = errorsFor((s) => {
      s["steps"] = [{ id: "o", kind: "card_order", amount: "10.005" }];
    });
    expect(errs.join(" ")).toMatch(/decimal places/i);
  });

  it("rejects cents on a zero decimal currency", () => {
    const errs = errorsFor((s) => {
      s["currency"] = "JPY";
      s["steps"] = [{ id: "o", kind: "card_order", amount: "10.00" }];
    });
    expect(errs.join(" ")).toMatch(/decimal places/i);
  });

  it("rejects negative, signed, exponential and comma amounts", () => {
    for (const bad of ["-1.00", "+1.00", "1e2", "1,000.00", "", "abc", "10."]) {
      const errs = errorsFor((s) => {
        s["steps"] = [{ id: "o", kind: "card_order", amount: bad }];
      });
      expect(errs.length, JSON.stringify(bad)).toBeGreaterThan(0);
    }
  });

  it("rejects an unknown currency rather than assuming two decimals", () => {
    const errs = errorsFor((s) => { s["currency"] = "XYZ"; });
    expect(errs.join(" ")).toMatch(/refusing to assume|3 letter/i);
  });
});

describe("validateScenario rejects broken dependencies", () => {
  it("rejects a dangling dependency and names it", () => {
    const errs = errorsFor((s) => {
      s["steps"] = [{ id: "o", kind: "card_order", amount: "1.00", needs: ["ghost"] }];
    });
    expect(errs.join(" ")).toContain("ghost");
  });

  it("rejects a duplicate step id", () => {
    const errs = errorsFor((s) => {
      s["steps"] = [
        { id: "o", kind: "card_order", amount: "1.00" },
        { id: "o", kind: "card_order", amount: "2.00" },
      ];
    });
    expect(errs.join(" ")).toMatch(/more than once/i);
  });

  it("rejects a dependency cycle", () => {
    const errs = errorsFor((s) => {
      s["steps"] = [
        { id: "a", kind: "card_order", amount: "1.00", needs: ["b"] },
        { id: "b", kind: "card_order", amount: "1.00", needs: ["a"] },
      ];
    });
    expect(errs.join(" ")).toMatch(/cycle/i);
  });

  it("rejects a self dependency", () => {
    const errs = errorsFor((s) => {
      s["steps"] = [{ id: "a", kind: "card_order", amount: "1.00", needs: ["a"] }];
    });
    expect(errs.join(" ")).toMatch(/itself/i);
  });
});

describe("validateScenario checks from references", () => {
  const withSteps = (steps: unknown[]) => errorsFor((s) => { s["steps"] = steps; });

  it("accepts a refund that references a card order it also needs", () => {
    const r = validateScenario(
      {
        ...base(),
        steps: [
          { id: "o", kind: "card_order", amount: "40.00" },
          { id: "r", kind: "refund", from: "o", mode: "partial", basisPoints: 2500, needs: ["o"] },
        ],
      },
      OPTS,
    );
    expect(r.ok).toBe(true);
  });

  it("rejects a refund referencing a step of the wrong kind", () => {
    const errs = withSteps([
      { id: "i", kind: "invoice_create", amount: "10.00" },
      { id: "r", kind: "refund", from: "i", mode: "full", needs: ["i"] },
    ]);
    expect(errs.join(" ")).toMatch(/must reference a card_order/i);
  });

  it("rejects a from reference that is not listed in needs", () => {
    const errs = withSteps([
      { id: "o", kind: "card_order", amount: "40.00" },
      { id: "r", kind: "refund", from: "o", mode: "full" },
    ]);
    expect(errs.join(" ")).toMatch(/does not list it in needs/i);
  });

  it("rejects a from reference to a step that does not exist", () => {
    const errs = withSteps([{ id: "r", kind: "refund", from: "nope", mode: "full", needs: ["nope"] }]);
    expect(errs.join(" ")).toMatch(/nope/);
  });

  it("requires invoice steps to reference an invoice_create", () => {
    const errs = withSteps([
      { id: "o", kind: "card_order", amount: "1.00" },
      { id: "s", kind: "invoice_send", from: "o", needs: ["o"] },
    ]);
    expect(errs.join(" ")).toMatch(/must reference a invoice_create/i);
  });
});

describe("validateScenario checks refund mode", () => {
  const twoStep = (refund: Record<string, unknown>) =>
    errorsFor((s) => {
      s["steps"] = [{ id: "o", kind: "card_order", amount: "40.00" }, refund];
    });

  it("rejects a partial refund with no basisPoints", () => {
    expect(twoStep({ id: "r", kind: "refund", from: "o", mode: "partial", needs: ["o"] }).join(" ")).toMatch(
      /must state basisPoints/i,
    );
  });

  it("rejects a full refund that sets basisPoints", () => {
    expect(
      twoStep({ id: "r", kind: "refund", from: "o", mode: "full", basisPoints: 100, needs: ["o"] }).join(" "),
    ).toMatch(/must not state basisPoints/i);
  });

  it("rejects basisPoints outside 1..9999", () => {
    for (const bp of [0, 10_000, -5, 1.5]) {
      const errs = twoStep({ id: "r", kind: "refund", from: "o", mode: "partial", basisPoints: bp, needs: ["o"] });
      expect(errs.length, String(bp)).toBeGreaterThan(0);
    }
  });
});

describe("validateScenario enforces the event target allowlist", () => {
  it("accepts an allowlisted webhook target", () => {
    const r = validateScenario({ ...base(), webhook: { target: `${STORE}/api/paypal/webhook` } }, OPTS);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.scenario.webhook!.eventTypes).toEqual(["*"]);
  });

  it("rejects a target that is not on the allowlist", () => {
    const errs = errorsFor((s) => {
      s["webhook"] = { target: "https://evil.test/hook" };
    });
    expect(errs.join(" ")).toMatch(/not on the allowlist/i);
  });

  // Fail closed: no configured origin means no scenario may fire events anywhere.
  it("rejects any target when the allowlist is empty", () => {
    const errs = errorsFor(
      (s) => {
        s["webhook"] = { target: `${STORE}/api/paypal/webhook` };
      },
      { allowedEventOrigins: [] },
    );
    expect(errs.join(" ")).toMatch(/allowlist is empty/i);
  });

  it("rejects a non-https target", () => {
    const errs = errorsFor((s) => {
      s["webhook"] = { target: "http://receiver-lyart.vercel.app/api/paypal/webhook" };
    });
    expect(errs.length).toBeGreaterThan(0);
  });
});
