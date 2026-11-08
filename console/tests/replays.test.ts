import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import facts from "../fixtures/facts.json";
import {
  FINDER,
  PLANS,
  RUNS,
  describeStep,
  grouped,
  planTotals,
  replayEndS,
  replayRead,
  runById,
  timelineRows,
} from "../lib/replays";
import { dur, runStory } from "../lib/runStory";

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
      expect(r.sources).toContain(`evidence/runs/${r.runId}.json`);
      expect(["bug", "ok"]).toContain(r.verdict);
    }
  });

  // A judge can open every file a replay cites: each is committed, none is a
  // local folder or a private note.
  it("cite only files committed under evidence/, and the store's own endpoint", () => {
    const repo = join(ROOT, "..");
    const cited = [...RUNS.flatMap((r) => r.sources), FINDER.before.report, FINDER.after.report];
    for (const s of cited) {
      if (s.startsWith("store state endpoint")) continue;
      expect(s, s).toMatch(/^evidence\//);
      expect(statSync(join(repo, s)).isFile(), s).toBe(true);
    }
    // The state file the replay copies is the one committed.
    for (const r of RUNS) {
      const state = JSON.parse(readFileSync(join(repo, "evidence", "runs", `${r.runId}.json`), "utf8")) as { runId: string };
      expect(state.runId).toBe(r.runId);
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

  // The page's verdict is the evidence report's own words, with only R-033's US spellings applied.
  it("each run: its finding is its evidence report's, word for word", () => {
    const us = (t: string) => t.replace(/fulfilment/g, "fulfillment").replace(/fulfils/g, "fulfills").replace(/recognised/g, "recognized");
    for (const side of ["before", "after"] as const) {
      const run = runById(FINDER[side].runId)!;
      const report = us(readFileSync(join(ROOT, "..", run.finding.source), "utf8"));
      expect(run.finding.source).toBe(FINDER[side].report);
      expect(run.finding.verdict).toBe(FINDER[side].verdict);
      expect(run.finding.title).toBe(FINDER.title);
      for (const [label, value] of [["Expected", run.finding.expected], ["Actual", run.finding.actual], ["Likely fix", run.finding.likelyFix]] as const) {
        expect(report, label).toContain(`- ${label}: ${value}
`);
      }
    }
  });

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

describe("a replay, drawn by the live run's own view", () => {
  const before = runById("20261023231552-60ea96")!;
  const after = runById("20261024011812-208f4e")!;

  it("orders calls and deliveries by time and measures latency from acceptance", () => {
    const rows = timelineRows(before);
    expect(rows.map((r) => (r.kind === "call" ? `c:${r.call.step}` : `d:${r.delivery.pair}`))).toEqual(["c:order", "d:order", "c:resend-capture", "d:resend-capture"]);
    const lat = rows.flatMap((r) => (r.kind === "delivery" ? [dur(r.latencyS)] : []));
    expect(lat).toEqual(["20s", "4s"]);
  });

  it("walks the states a live run shows: sending, accepted and waiting, delivered", () => {
    const sending = runStory(replayRead(before, 2));
    expect(sending.headline).toBe("Running step 1 of 2: Capture a card payment.");
    expect(sending.cards[0]!.sent).toBe("sending");
    expect(sending.cards[0]!.current).toBe(true);

    const waiting = runStory(replayRead(before, 10));
    expect(waiting.cards[0]!).toMatchObject({ sent: "accepted", reply: "waiting", amount: "USD 25" });
    // The queued resend shows the event it will wait for, so the strip counts what the hero counts.
    expect(waiting.proof.map((n) => `${n.step} ${n.arrived}`)).toEqual(["1 false", "2 false"]);

    const delivered = runStory(replayRead(before, 30));
    expect(delivered.cards[0]!.reply).toBe("delivered");
    expect(delivered.cards[0]!.replies[0]!).toMatchObject({ plain: "Payment completed", rank: 1, verified: 1, copies: 1 });
  });

  it("ends on the recorded verdict's evidence: the before run fulfills twice, the after run ignores the repeat", () => {
    const b = runStory(replayRead(before, replayEndS(before)));
    expect(b.tone).toBe("done");
    expect(b.headline).toBe("All 2 steps done.");
    expect(b.lead).toBe("2 of 2 expected events arrived, all verified.");
    // The finder's verdict leads the page, never a green "Done" above a BUG.
    expect(b.verdict).toEqual({ kind: "bug", headline: "BUG: one payment event was fulfilled twice.", lead: "Event WH-23242717T8452430B-4FP87531JX1278159 was delivered 2 times and fulfilled 2 times." });
    expect(b.cards[1]!.replies[0]!.plain).toBe("PayPal delivered it again; the store fulfilled the order a second time");
    const a = runStory(replayRead(after, replayEndS(after)));
    expect(a.cards[1]!.replies[0]!.plain).toBe("PayPal delivered it again; the store recognized it as a repeat and ignored it");
    expect(a.figures).toMatchObject({ steps: "2 of 2", amount: "USD 25", slowest: "20s", signatures: "2 of 2", signaturesOk: true });
    expect(a.verdict?.kind).toBe("ok");
    expect(a.verdict?.headline).toBe("OK: the payment was fulfilled once, and PayPal's redelivery was recognized as a repeat and ignored.");
    expect(a.proof.map((n) => `${n.label} ${n.latencyS === null ? "" : dur(n.latencyS)}`)).toEqual(["Payment 20s", "Resend 4s"]);
    expect(a.proof.map((n) => n.step)).toEqual([1, 2]);
  });

  it("uses only the fixture's own ids and times", () => {
    const read = replayRead(after, replayEndS(after));
    const finished = read.events.find((e) => e.kind === "step_finished" && e.step_id === "order")!;
    expect(finished.data["ids"]).toEqual({ order_id: "9XW82145R0198523E", capture_id: "7FK80862277639113" });
    expect(finished.at).toBe("2026-10-24T01:18:16.848Z");
    expect(read.events.filter((e) => e.kind === "delivery").map((e) => e.at)).toEqual(["2026-10-24T01:18:37Z", "2026-10-24T01:19:21Z"]);
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
      if (text.includes("<LiveBanner>")) {
        expect(text, f).not.toMatch(/\b(RUNS|FINDER|runById)\b/);
        expect(readFileSync(join(ROOT, "components", "LiveBuilder.tsx"), "utf8")).toContain("A recorded plan");
      } else if (f === join(ROOT, "app", "page.tsx")) {
        // The home page is neither live nor a replay. Its one use of recorded
        // data, the before and after bug cards, says so in its own heading and
        // links only to the replays, which carry the banner.
        expect(text).toContain("Two recorded sandbox runs:");
        expect(text).not.toMatch(/\b(RUNS|runById|PLANS)\b/);
        const links = text.match(/href=\{`[^`]*\$\{FINDER[^`]*`\}/g) ?? [];
        expect(links).toHaveLength(2);
        for (const href of links) expect(href).toMatch(/^href=\{`\/runs\//);
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
