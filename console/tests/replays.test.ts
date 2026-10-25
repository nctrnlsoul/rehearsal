import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import facts from "../fixtures/facts.json";
import {
  FINDER,
  PLANS,
  RUNS,
  describeStep,
  gapHeightPx,
  grouped,
  latencyLabel,
  planTotals,
  runById,
  timelineRows,
} from "../lib/replays";

const ROOT = join(__dirname, "..");

function filesUnder(dir: string, ext: RegExp): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (name === "node_modules" || name === ".next") return [];
    return statSync(p).isDirectory() ? filesUnder(p, ext) : ext.test(name) ? [p] : [];
  });
}

describe("run fixtures", () => {
  it("hold the two recorded runs, each with its sources", () => {
    expect(RUNS.map((r) => r.runId)).toEqual(["20261023231552-60ea96", "20261024011812-208f4e"]);
    for (const r of RUNS) {
      expect(r.runId).toMatch(/^\d{14}-[0-9a-f]{6}$/);
      expect(r.sources).toContain(`runs/${r.runId}.json`);
      expect(["bug", "ok"]).toContain(r.verdict);
    }
  });

  it("pair every delivery with a call that PayPal accepted before it", () => {
    for (const r of RUNS) {
      for (const d of r.deliveries) {
        const call = r.calls.find((c) => c.step === d.pair);
        expect(call, `${r.runId} ${d.pair}`).toBeDefined();
        expect(Date.parse(d.at)).toBeGreaterThan(Date.parse(call!.acceptedAt));
        expect(Date.parse(call!.acceptedAt)).toBeGreaterThanOrEqual(Date.parse(call!.startedAt));
        expect(d.eventId).toMatch(/^WH-[0-9A-Z]+-[0-9A-Z]+$/);
        expect(["fulfilled", "duplicate_ignored"]).toContain(d.store);
      }
    }
  });

  it("put the recorded ids in sandbox shape", () => {
    for (const r of RUNS) {
      const order = r.calls.find((c) => c.kind === "card_order")!;
      expect(order.ids["order"]).toMatch(/^[0-9A-Z]{17}$/);
      expect(order.ids["capture"]).toMatch(/^[0-9A-Z]{17}$/);
    }
  });
});

describe("finder fixture agrees with the run fixtures it summarizes", () => {
  for (const side of ["before", "after"] as const) {
    it(`${side}: counts match the store rows`, () => {
      const s = FINDER[side];
      const run = runById(s.runId)!;
      expect(run).toBeDefined();
      expect(run.verdict).toBe(s.verdict);
      expect(s.deliveries).toBe(run.deliveries.length);
      expect(s.fulfilled).toBe(run.deliveries.filter((d) => d.store === "fulfilled").length);
      expect(s.ignored).toBe(run.deliveries.filter((d) => d.store === "duplicate_ignored").length);
      expect(s.verified).toBe(run.deliveries.filter((d) => d.verified).length);
    });
  }

  it("uses US spelling in its title (R-033)", () => {
    expect(FINDER.title).toBe("A redelivered capture event fulfills the order twice");
  });
});

describe("plan fixtures", () => {
  it("carry an engine-computed digest and cap total", () => {
    for (const p of PLANS) {
      expect(p.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(p.capsTotal).toMatch(/^\d+\.\d{2}$/);
      expect(p.violations).toBe(0);
    }
  });

  it("total charges and invoices in integer cents", () => {
    const bakery = PLANS.find((p) => p.plan === "plan-20261023193216")!;
    expect(planTotals(bakery)).toEqual({ charged: "USD 105.00", invoiced: "USD 120.00", disputes: 0, creates: 5 });
    // The caps also count the recorded invoice payment, which the dry-run totals do not.
    expect(bakery.capsTotal).toBe("345.00");
  });

  it("describes steps in the plan's own words", () => {
    const bakery = PLANS.find((p) => p.plan === "plan-20261023193216")!;
    expect(describeStep(bakery.scenario.steps[0]!, "USD")).toBe("Customer buys pastries, USD 45.00 captured by card");
    expect(describeStep(bakery.scenario.steps[2]!, "USD")).toBe("Invoice for catering order, USD 120.00, due in 7 days");
  });
});

describe("grouped", () => {
  it("adds thousands separators for reading, and nothing else", () => {
    expect(grouped("2000.00")).toBe("2,000.00");
    expect(grouped("345.00")).toBe("345.00");
    expect(grouped("1234567.89")).toBe("1,234,567.89");
  });
});

describe("timeline math", () => {
  it("orders calls and deliveries by time and measures latency from acceptance", () => {
    const rows = timelineRows(runById("20261023231552-60ea96")!);
    expect(rows.map((r) => (r.kind === "call" ? `c:${r.call.step}` : `d:${r.delivery.pair}`))).toEqual([
      "c:order",
      "d:order",
      "c:resend-capture",
      "d:resend-capture",
    ]);
    const lat = rows.filter((r) => r.kind === "delivery").map((r) => (r.kind === "delivery" ? latencyLabel(r.latencyS) : ""));
    expect(lat).toEqual(["20 s", "4 s"]);
  });

  it("shows latency to the second, the precision the store records", () => {
    expect(latencyLabel(3.743)).toBe("4 s");
    expect(latencyLabel(20.294)).toBe("20 s");
    expect(latencyLabel(-1)).toBe("0 s");
  });

  it("compresses dead time but keeps longer waits taller", () => {
    expect(gapHeightPx(0)).toBe(8);
    expect(gapHeightPx(4)).toBeLessThan(gapHeightPx(20));
    expect(gapHeightPx(90)).toBeLessThanOrEqual(40);
    expect(gapHeightPx(10_000)).toBe(40);
  });
});

describe("facts", () => {
  it("adds up", () => {
    const t = facts.tests;
    expect(t.engine + t.store + t.receiver + t.console).toBe(t.total);
    expect(facts.measuredOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("Stage A boundaries", () => {
  const source = [...filesUnder(join(ROOT, "app"), /\.tsx?$/), ...filesUnder(join(ROOT, "lib"), /\.ts$/), ...filesUnder(join(ROOT, "components"), /\.tsx?$/), join(ROOT, "middleware.ts")];

  // A live page may list the recorded plans, because there they run live; it
  // then says LIVE and calls each one "a recorded plan". Anything else that
  // reads the recorded data says REPLAY.
  it("labels every page that shows recorded data as REPLAY, or as LIVE with its recorded plans named as recorded", () => {
    const pages = source.filter((f) => /page\.tsx$/.test(f));
    const usesReplays = pages.filter((f) => /lib\/replays/.test(readFileSync(f, "utf8")));
    expect(usesReplays.length).toBeGreaterThanOrEqual(4);
    for (const f of usesReplays) {
      const text = readFileSync(f, "utf8");
      if (text.includes('className="live-banner"')) {
        expect(text, f).not.toMatch(/\b(RUNS|FINDER|runById)\b/);
        expect(readFileSync(join(ROOT, "components", "LiveBuilder.tsx"), "utf8")).toContain("A recorded plan");
      } else {
        expect(text, f).toMatch(/<ReplayBanner>/);
      }
    }
  });

  // Stage B adds outbound calls on purpose, so this names where they may live.
  // A page, a component, the middleware or the replay code that grew one would
  // be a new path to PayPal, a model or the database that skipped the gate.
  const OUTBOUND_ALLOWED = new Set(
    ["lib/db.ts", "lib/engine.ts", "lib/worker.ts", "lib/live.ts"].map((p) => join(ROOT, ...p.split("/"))),
  );
  const isApiRoute = (f: string) => f.startsWith(join(ROOT, "app", "api"));

  it("makes outbound calls only from the named server modules and API routes", () => {
    for (const f of source) {
      if (OUTBOUND_ALLOWED.has(f) || isApiRoute(f)) continue;
      const text = readFileSync(f, "utf8");
      expect(text, f).not.toMatch(/@ai-sdk|from ["']ai["']|PaypalClient|api-m\.sandbox\.paypal\.com\/v/);
      expect(text, f).not.toMatch(/lib\/(db|engine|worker|live)["']/);
    }
  });

  // The server reaches the network only through lib/db.ts (the engine's own
  // PayPal and model clients aside). A browser component may call this
  // console's own /api/ routes, which run every check, and nothing else.
  it("fetches only from the database client, and from the browser only this console's /api/", () => {
    for (const f of source) {
      if (f === join(ROOT, "lib", "db.ts")) continue;
      const text = readFileSync(f, "utf8");
      const calls = text.match(/\bfetch\s*\(\s*.{0,8}/g) ?? [];
      const browser = text.startsWith('"use client"') && f.startsWith(join(ROOT, "components"));
      for (const call of calls) {
        expect(browser && /^fetch\s*\(\s*[`'"]\/api\//.test(call), `${f}: ${call}`).toBe(true);
      }
    }
  });

  it("checks a run id's shape exactly as the engine does", async () => {
    const { RUN_ID_SHAPE } = await import("../lib/liveView");
    const { RUN_ID_PATTERN } = await import("../lib/engine");
    expect(RUN_ID_SHAPE.source).toBe(RUN_ID_PATTERN.source);
  });

  // A server component cannot run outside a request, so its wiring is checked at
  // the source: the session check and the redirect come before anything renders.
  it("checks the session on /live before rendering, and sends everyone else to the gate", () => {
    const live = readFileSync(join(ROOT, "app", "live", "page.tsx"), "utf8");
    const check = live.indexOf('if (!hasValidSession(jar.get(SESSION_COOKIE)?.value, process.env, Date.now())) redirect("/gate");');
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(live.indexOf("return ("));
  });

  it("uses US spelling in what it renders (R-033)", () => {
    for (const f of source) {
      expect(readFileSync(f, "utf8"), f).not.toMatch(/\b(fulfil|fulfils|fulfilment|recognis\w*|cancelled|colour|behaviour|honour\w*|licence)\b/i);
    }
  });
});
