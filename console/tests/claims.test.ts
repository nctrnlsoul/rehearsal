import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_LIMITS } from "../lib/gate";

/**
 * The claims a judge reads, held to the code they describe (audit 2026-10-25
 * L3). Three were overstated: caps "the same hosted or local" (a local install
 * sets them by env), webhooks "verified: every delivery" (the receiver records
 * unverified arrivals and answers 200), and "5 wrong tries lock a network out
 * for an hour" (one address or IPv6 /64, counted per server instance).
 *
 * The pages are read as source, so this checks the words that ship, and the
 * code is read from the other packages, so a change there breaks this.
 */

const ROOT = join(__dirname, "..", "..");
const read = (...parts: string[]) => readFileSync(join(ROOT, ...parts), "utf8");
const trust = read("console", "app", "page.tsx");
const gate = read("console", "app", "gate", "page.tsx");

describe("caps claim", () => {
  it("says a local install can change the caps, and names the variables the code reads", () => {
    expect(trust).not.toContain("the same for every scenario, hosted or local");
    expect(trust).toContain("a local install can change them with REHEARSAL_MAX_* variables");
    const caps = read("src", "core", "caps.ts");
    for (const name of ["REHEARSAL_MAX_STEPS", "REHEARSAL_MAX_DISPUTES", "REHEARSAL_MAX_STEP_AMOUNT", "REHEARSAL_MAX_RUN_TOTAL"]) {
      expect(caps).toContain(`"${name}"`);
    }
  });

  it("shows the defaults the code holds", () => {
    const caps = read("src", "core", "caps.ts");
    expect(caps).toMatch(/maxStepAmountMinor: 50_000n/);
    expect(caps).toMatch(/maxTotalMinor: 200_000n/);
    expect(caps).toMatch(/maxSteps: 30,/);
    expect(caps).toMatch(/maxDisputes: 2,/);
    // Rendered from DEFAULT_CAPS; the figures themselves are pinned above.
    for (const shown of ["usd(DEFAULT_CAPS.maxStepAmountMinor)", "usd(DEFAULT_CAPS.maxTotalMinor)", "{DEFAULT_CAPS.maxSteps}", "{DEFAULT_CAPS.maxDisputes}"]) expect(trust).toContain(shown);
  });

  it("shows the hosted caps from the constants the routes enforce, here and on the gate", () => {
    expect(trust).toContain("HOSTED_CAPS.maxStepAmountMinor");
    expect(trust).toContain("HOSTED_CAPS.maxTotalMinor");
    expect(gate).toContain("usd(HOSTED_CAPS.maxTotalMinor)");
    expect(gate).not.toContain("USD 2,000.00");
    expect(gate).toContain("liveRunsEnabled(process.env)");
  });

  it("never says live runs are still to come", () => {
    for (const page of ["page.tsx", "build/page.tsx", "finder/page.tsx", "gate/page.tsx", "runs/page.tsx", "live/page.tsx"]) {
      expect(read("console", "app", ...page.split("/")), page).not.toMatch(/arrive in Stage B|Stage A/);
    }
  });
});

describe("webhook claim", () => {
  // R-045: a plan with no webhook registers none, but PayPal still delivers the
  // account's events to every webhook registered on it, the store's included.
  it("never says a plan without a webhook stops deliveries, in the engine's dry run or on /build", () => {
    const line = "none declared by this plan; PayPal still delivers this account's events to every webhook registered on it";
    for (const [name, text] of [["src/executor/dryRun.ts", read("src", "executor", "dryRun.ts")], ["build/page.tsx", read("console", "app", "build", "page.tsx")], ["lib/planView.ts", read("console", "lib", "planView.ts")]] as const) {
      expect(text, name).toContain(line);
      expect(text, name).not.toMatch(/no events will be delivered|so no webhook will be registered"/);
    }
  });

  // R-044: the store's receive times make a latency exact, so no page may still call every time an upper bound.
  it("says a delivery's time is the store's own receive time, and an upper bound only from an older store", () => {
    const runPage = read("console", "app", "live", "[runId]", "page.tsx");
    expect(runPage).not.toContain("so its time is an upper bound");
    expect(runPage).toContain("at the time the store recorded receiving it, so a latency is exact to the second");
    expect(read("store", "lib", "merchant.ts")).toContain(".map((ms) => new Date(ms).toISOString())");
  });

  it("no longer says every delivery is verified", () => {
    expect(trust).not.toMatch(/Webhooks verified[\s\S]{0,200}every delivery/);
  });

  it("says the store acts on verified events only, which its code requires", () => {
    expect(trust).toContain("Webhooks the sample store acts on");
    expect(trust).toContain("Verified only");
    expect(read("store", "lib", "merchant.ts")).toContain("if (opts.verified !== true) {");
    expect(read("store", "lib", "verify.ts")).toContain('out.verification_status === "SUCCESS"');
  });

  it("says the receiver records every arrival, marked, which its code does", () => {
    expect(trust).toContain("Webhooks the receiver records");
    const route = read("receiver", "app", "api", "paypal", "webhook", "route.ts");
    // One append per parsed delivery, whatever verify returned, then 200.
    expect(route).toMatch(/await createLedger\(config\)\.append\(\{[\s\S]*verified,/);
    expect(route).toContain("return Response.json({ ok: true }, { status: 200 });");
  });

  it("counts the cert hosts it claims, in both apps", () => {
    expect(trust).toContain("cert host on an exact list of 4");
    for (const file of [read("store", "lib", "verify.ts"), read("receiver", "lib", "certUrl.ts")]) {
      const list = /PAYPAL_CERT_HOSTS[^=]*= new Set\(\[([\s\S]*?)\]\)/.exec(file)![1]!;
      expect(list.match(/"[^"]+"/g)).toHaveLength(4);
    }
  });
});

describe("gate lockout claim", () => {
  it("names an address or /64, an hour, and one shared count, as the code does", () => {
    expect(gate).not.toContain("lock a network out");
    expect(gate).not.toContain("counted by each server instance on its own");
    expect(gate).toContain("{DEFAULT_LIMITS.perIp} wrong tries from one address (one /64 on IPv6) lock it out for an hour, counted in one place for every server.");
    // R-049: judges on one corporate network share an address.
    expect(DEFAULT_LIMITS.perIp).toBe(30);
    expect(DEFAULT_LIMITS.windowMs).toBe(60 * 60 * 1000);
    // One place: the route counts through the database store, never in memory.
    const route = read("console", "app", "api", "gate", "route.ts");
    expect(route).toContain("dbAttemptStore(db, secret)");
    expect(read("console", "lib", "gate.ts")).not.toMatch(/new Map</);
    const sqlFile = read("console", "migrations", "0003_plans_counters.sql");
    expect(sqlFile).toContain("function public.console_gate_take");
  });

  it("never says a network is locked, since the key is an address", () => {
    expect(gate).not.toMatch(/this network/i);
  });
});

// Re-measured for v0.7.1: the trust panel's figures read the constants the
// code enforces, so a changed cap or budget changes the page with it.
describe("trust panel figures", () => {
  it("come from the code's constants, not typed-in numbers", () => {
    for (const source of [
      "usd(DEFAULT_CAPS.maxStepAmountMinor)",
      "usd(DEFAULT_CAPS.maxTotalMinor)",
      "DEFAULT_CAPS.maxSteps",
      "DEFAULT_CAPS.maxDisputes",
      "usd(HOSTED_CAPS.maxStepAmountMinor)",
      "DEFAULT_AI_BUDGET.maxOutputTokensPerCall",
      "PLANNER_TIMEOUT_MS / 1000",
      "count(DESCRIPTION_MAX_CHARS)",
      "facts.version",
    ]) {
      expect(trust, source).toContain(source);
    }
    for (const literal of ["USD 500.00", "USD 2,000.00", "4,000 tokens", "4,000 chars", "facts.branch"]) {
      expect(trust, literal).not.toContain(literal);
    }
    expect(trust).toContain("the reports are in the repo under evidence/");
  });
});

// v0.7.3 (audit 2026-11-07 evening): one vocabulary on every run surface.
// Accepted is PayPal taking the API call, Arrived is the webhook reaching the
// store, Verified is its signature passing PayPal's check.
describe("run vocabulary and v0.7.3 wording", () => {
  // Every page and component a judge can open, plus the two libraries that write the run's sentences.
  const walk = (dir: string): string[] =>
    readdirSync(join(ROOT, "console", dir), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : /\.tsx$/.test(e.name) ? [join(dir, e.name)] : []));
  const surfaces = [...walk("app"), ...walk("components"), "lib/runStory.ts", "lib/nowPanel.ts"].map((p) => [p, read("console", ...p.split(/[\\/]/))] as const);

  it("never says confirmed, passed, replied or that no step causes an event", () => {
    for (const [name, text] of surfaces) {
      expect(text, name).not.toMatch(/PayPal confirmed|PayPal replied|Replied in|reply comes|no reply yet|signatures? passed|copies passed|no step causes|Slowest reply|PayPal(&apos;|')s reply (fill|land)|Never confirmed/);
    }
    expect(surfaces.length).toBeGreaterThan(15);
  });

  it("says a latency as Arrived Ns after the call", () => {
    expect(read("console", "components", "RunView.tsx")).toContain("`Arrived ${r.exact ? \"\" : \"at most \"}${dur(r.latencyS!)} after the call`");
  });

  it("words the finder story as reproducing the classic bug, never as catching a real one", () => {
    const line = "reproduces the classic duplicate-delivery bug with PayPal&apos;s real redelivery, then proves the one-line fix";
    expect(read("console", "app", "finder", "page.tsx")).toContain(line);
    for (const page of ["page.tsx", "finder/page.tsx"]) expect(read("console", "app", ...page.split("/")), page).not.toMatch(/caught a real bug|the bug it found/);
    expect(read("README.md")).not.toMatch(/caught a real bug|the bug it found/);
  });

  it("shows only hosted caps on /build, which leads to a hosted run", () => {
    const build = read("console", "app", "build", "page.tsx");
    expect(build).not.toContain("PLAN_CAPS");
    for (const c of ["HOSTED_CAPS.maxTotalMinor", "HOSTED_CAPS.maxStepAmountMinor", "HOSTED_CAPS.maxSteps", "HOSTED_CAPS.maxDisputes"]) expect(build).toContain(c);
  });

  it("keeps the dry run's waves and digest out of the plan a person reads", () => {
    const view = read("console", "lib", "planView.ts");
    // In a string the page shows, not in the comment that explains why they are left out.
    expect(view).not.toMatch(/["`][^"`\n]*\bwaves?\b|\$\{s\.kind\}/);
    const builder = read("console", "components", "LiveBuilder.tsx");
    expect(builder).toContain("Plan fingerprint");
    expect(builder).not.toMatch(/<dt>Digest<\/dt>/);
  });

  it("drops the timing claim no recorded run backs", () => {
    expect(trust).not.toContain("more than 2 min");
  });
});
