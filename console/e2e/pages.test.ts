import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { PGlite } from "@electric-sql/pglite";
import { type Browser, type BrowserContext, type Page, chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HOSTED_REPLAYS } from "../lib/hostedReplays";
import { RUNS, replayEndS } from "../lib/replays";
import { type Fixture, absolute, disputeRun, hostedAt, recordedAt, tinyBakery, tokenRefused } from "../tests/fixtures/liveRuns";
import { hashFor } from "../tests/helpers";
import { TEST_DB_ENV } from "../tests/postgrest";
import { FAKE_SUPABASE_HOST, startFakeSupabase } from "./fakeSupabase";

/**
 * Every page, as `next build` produced it, in real Chromium under the real
 * headers. Unit tests can read the CSP string; only a browser can say whether
 * the scripts it blocks are the ones the page needs, and only a browser decides
 * what Origin a form POST carries.
 *
 * The passcode and session secret are throwaway values made here; nothing reads
 * the real environment's gate settings.
 */

const ROOT = join(__dirname, "..");
const PASSCODE = `e2e-${randomBytes(12).toString("hex")}`;

let server: ChildProcess;
let base: string;
let db: Awaited<ReturnType<typeof startFakeSupabase>>;
let browser: Browser;
let serverLog = "";

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "localhost", () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });
}

beforeAll(async () => {
  if (!existsSync(join(ROOT, ".next", "BUILD_ID"))) throw new Error("No production build: run `npm run build` first.");
  const port = await freePort();
  base = `http://localhost:${port}`;
  db = await startFakeSupabase();
  server = spawn(process.execPath, [join(ROOT, "node_modules", "next", "dist", "bin", "next"), "start", "-p", String(port), "-H", "localhost"], {
    cwd: ROOT,
    env: {
      ...process.env,
      // vitest sets NODE_ENV=test; the server under test must be production.
      NODE_ENV: "production",
      CONSOLE_PASSCODE_HASH: hashFor(PASSCODE),
      CONSOLE_SESSION_SECRET: randomBytes(32).toString("hex"),
      // The console's database is a local PGlite with the committed migrations
      // (e2e/fakeSupabase.ts); the app still sees an https supabase.co URL.
      SUPABASE_URL: `https://${FAKE_SUPABASE_HOST}`,
      SUPABASE_SERVICE_ROLE_KEY: TEST_DB_ENV.SUPABASE_SERVICE_ROLE_KEY,
      E2E_SUPABASE_REDIRECT: `http://localhost:${db.port}`,
      NODE_OPTIONS: `--import ${pathToFileURL(join(__dirname, "redirect-supabase.mjs")).href}`,
      CONSOLE_LIVE_RUNS: "on",
      REHEARSAL_STORE_ORIGIN: "https://rehearsal-store.vercel.app",
      // The machine running this may hold real values for any of these; the
      // server under test must not inherit them. A second event origin would
      // also, correctly, stop every live route.
      REHEARSAL_RECEIVER_ORIGIN: "",
      REHEARSAL_EVENT_ORIGINS: "",
      REHEARSAL_STORE_TOKEN: "",
      REHEARSAL_RECEIVER_TOKEN: "",
      REHEARSAL_STORE_WEBHOOK_ID: "",
      // No PayPal or model keys: nothing in this suite can reach either.
      PAYPAL_SELLER_CLIENT_ID: "",
      PAYPAL_SELLER_CLIENT_SECRET: "",
      PAYPAL_BUYER_CLIENT_ID: "",
      PAYPAL_BUYER_CLIENT_SECRET: "",
      ANTHROPIC_API_KEY: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout?.on("data", (d) => (serverLog += d));
  server.stderr?.on("data", (d) => (serverLog += d));

  const deadline = Date.now() + 45_000;
  for (;;) {
    try {
      if ((await fetch(base + "/gate")).status === 200) break;
    } catch {
      // Not listening yet.
    }
    if (server.exitCode !== null || Date.now() > deadline) throw new Error(`next start did not come up:\n${serverLog}`);
    await new Promise((r) => setTimeout(r, 250));
  }
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser?.close();
  server?.kill();
  await db?.close();
});

type Watch = { problems: string[] };

/** A context that records every CSP violation, page error and console error or warning. */
async function watched(opts: { javaScriptEnabled?: boolean; reducedMotion?: "reduce" | "no-preference" } = {}): Promise<{ ctx: BrowserContext; page: Page; watch: Watch }> {
  const ctx = await browser.newContext(opts);
  const page = await ctx.newPage();
  const watch: Watch = { problems: [] };
  await ctx.exposeBinding("__cspViolation", (_src, msg: string) => void watch.problems.push(`CSP: ${msg}`));
  await ctx.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (e) => {
      (window as unknown as { __cspViolation: (m: string) => void }).__cspViolation(`${e.violatedDirective} blocked ${e.blockedURI || "inline"}`);
    });
  });
  page.on("pageerror", (e) => watch.problems.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") watch.problems.push(`console.${m.type()}: ${m.text()} @ ${m.location().url}`);
  });
  return { ctx, page, watch };
}

/** React attaches its fiber to the host elements it hydrates; a page whose scripts never ran has none. */
const hydrated = (page: Page) =>
  page.waitForFunction(() => Object.keys(document.body).some((k) => k.startsWith("__reactFiber")), undefined, { timeout: 10_000 });

/**
 * Loads one page and holds it to every check. The final URL must be the one
 * asked for, so a page that redirects away cannot pass on another page's merits.
 */
async function expectCleanPage(page: Page, watch: Watch, path: string, status: number): Promise<void> {
  const res = await page.goto(base + path, { waitUntil: "load" });
  expect(page.url()).toBe(base + path);
  expect(res?.status()).toBe(status);

  // The nonce the header allows is the one every served script carries.
  const csp = (await res!.allHeaders())["content-security-policy"] ?? "";
  expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);
  const nonce = /'nonce-([A-Za-z0-9+/=]+)'/.exec(csp)?.[1];
  expect(nonce).toBeDefined();
  const html = await res!.text();
  const scripts = html.match(/<script\b[^>]*>/g) ?? [];
  expect(scripts.length).toBeGreaterThan(0);
  expect(scripts.filter((s) => !s.includes(`nonce="${nonce}"`))).toEqual([]);

  await hydrated(page);
  await page.waitForLoadState("networkidle");
  // On a 404 page the browser notes the document's own status; a missing chunk,
  // font or stylesheet is reported against its own URL and still fails.
  const allowed = status === 404 ? `status of 404 (Not Found) @ ${base + path}` : null;
  expect(watch.problems.filter((p) => allowed === null || !p.endsWith(allowed))).toEqual([]);
}

// /live is not here: without a session it redirects to /gate. It is loaded past the gate below.
const HOSTED = HOSTED_REPLAYS[0]!;
const PAGES = ["/", "/build", "/runs", ...HOSTED_REPLAYS.map((h) => `/runs/${h.runId}`), ...RUNS.map((r) => `/runs/${r.runId}`), "/finder", "/gate"];

describe("every page hydrates under the CSP", () => {
  it.each(PAGES)("%s", async (path) => {
    const { ctx, page, watch } = await watched();
    await expectCleanPage(page, watch, path, 200);
    await ctx.close();
  });

  it("an unknown run is a 404 page that still hydrates cleanly", async () => {
    const { ctx, page, watch } = await watched();
    await expectCleanPage(page, watch, "/runs/not-a-recorded-run", 404);
    await ctx.close();
  });
});

describe("the gate, submitted by a real browser", () => {
  // These share the server's attempt count, in order: two wrong tries in all.

  it("without JavaScript, a wrong passcode comes back to /gate with the message, and the right one opens /live", async () => {
    const { ctx, page, watch } = await watched({ javaScriptEnabled: false });
    await page.goto(base + "/gate");
    await page.fill("#passcode", "not the passcode");
    await Promise.all([page.waitForURL(/\/gate\?e=wrong&left=\d+$/), page.click("button[type=submit]")]);
    await expect(page.locator("#pass-state").textContent()).resolves.toContain("That passcode did not match");

    await page.fill("#passcode", PASSCODE);
    await Promise.all([page.waitForURL(`${base}/live`), page.click("button[type=submit]")]);
    await expect(page.locator("h1").textContent()).resolves.toBe("Run a plan in PayPal's sandbox.");
    expect((await ctx.cookies()).map((c) => c.name)).toContain("__Host-rehearsal_session");
    expect(watch.problems).toEqual([]);
    await ctx.close();
  });

  it("with JavaScript, on the hydrated page, a wrong passcode shows the message, never a bare refusal", async () => {
    const { ctx, page, watch } = await watched();
    await page.goto(base + "/gate");
    await hydrated(page);
    await page.fill("#passcode", "still not the passcode");
    await Promise.all([page.waitForURL(/\/gate\?e=wrong&left=\d+$/), page.click("button[type=submit]")]);
    await hydrated(page);
    await expect(page.locator("#pass-state").textContent()).resolves.toMatch(/That passcode did not match.*left this hour/);
    expect(watch.problems).toEqual([]);
    await ctx.close();
  });

  it("past the gate, /live hydrates under the CSP", async () => {
    const { ctx, page, watch } = await watched();
    await page.goto(base + "/gate");
    await page.fill("#passcode", PASSCODE);
    await Promise.all([page.waitForURL(`${base}/live`), page.click("button[type=submit]")]);
    await expectCleanPage(page, watch, "/live", 200);
    await expect(page.locator("h1").textContent()).resolves.toBe("Run a plan in PayPal's sandbox.");
    await ctx.close();
  });

  it("a form posted from another site is refused back to /gate with the message", async () => {
    const { ctx, page } = await watched();
    // A page on a different origin, served by the browser itself, posting at the gate.
    await page.route("http://other-site.test/", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `<form method="post" action="${base}/api/gate"><input name="passcode" value="${PASSCODE}"><button>go</button></form>`,
      }),
    );
    await page.goto("http://other-site.test/");
    await Promise.all([page.waitForURL(`${base}/gate?e=refused`), page.click("button")]);
    await expect(page.locator("#pass-state").textContent()).resolves.toContain("That request was refused");
    expect((await ctx.cookies(base)).map((c) => c.name)).not.toContain("__Host-rehearsal_session");
    await ctx.close();
  });
});

// R-037: the NorthSchema blossom as maker's mark, ink on light (D2), in the header
// and favicon; the footer credit is text (vault ruling J-023).
describe("maker's mark", () => {
  it.each(PAGES)("%s shows the blossom in the header and credits NorthSchema in text below", async (path) => {
    const { ctx, page } = await watched();
    await page.goto(base + path, { waitUntil: "load" });
    const mark = await page.locator(".topbar img.maker-mark").evaluate((img: HTMLImageElement) => {
      const r = img.getBoundingClientRect();
      return { loaded: img.complete && img.naturalWidth > 0, natural: [img.naturalWidth, img.naturalHeight], height: r.height, alt: img.alt, src: new URL(img.src).pathname };
    });
    expect(mark).toEqual({ loaded: true, natural: [76, 72], height: 36, alt: "Made by NorthSchema", src: "/northschema-blossom-ink.png" });
    expect(await page.locator("footer.site").innerText()).toMatch(/by NorthSchema$/);
    expect(await page.locator("footer.site img").count()).toBe(0);
    await ctx.close();
  });

  // Brief v0.7.1 section 3: cap height 60 to 65% of the blossom, weight 600, optically centered.
  it.each([1440, 390])("the wordmark balances the blossom at %i wide", async (width) => {
    const { ctx, page } = await watched();
    await page.setViewportSize({ width, height: 900 });
    await page.goto(base + "/", { waitUntil: "networkidle" });
    const m = await page.evaluate(() => {
      const img = document.querySelector(".maker-mark")!.getBoundingClientRect();
      const wm = document.querySelector(".wordmark")!;
      const cs = getComputedStyle(wm);
      const c = document.createElement("canvas").getContext("2d")!;
      c.font = `${cs.fontWeight} 1000px ${cs.fontFamily}`;
      const capEm = c.measureText("R").actualBoundingBoxAscent / 1000;
      const r = wm.getBoundingClientRect();
      return { capRatio: (capEm * parseFloat(cs.fontSize)) / img.height, weight: cs.fontWeight, midGap: Math.abs(r.top + r.height / 2 - (img.top + img.height / 2)), gap: r.left - img.right, scroll: document.documentElement.scrollWidth <= innerWidth };
    });
    expect(m.capRatio).toBeGreaterThanOrEqual(0.6);
    expect(m.capRatio).toBeLessThanOrEqual(0.65);
    expect(m.weight).toBe("600");
    expect(m.midGap).toBeLessThanOrEqual(1);
    expect(m.gap).toBe(12);
    expect(m.scroll).toBe(true);
    await ctx.close();
  });

  it("the favicon is the blossom PNG, and the old letter icon is gone", async () => {
    const { ctx, page } = await watched();
    await page.goto(base + "/", { waitUntil: "load" });
    const href = await page.locator('link[rel="icon"]').first().getAttribute("href");
    expect(href).toMatch(/^\/icon\.png/);
    const icon = await fetch(base + href!);
    expect(icon.status).toBe(200);
    expect(icon.headers.get("content-type")).toBe("image/png");
    const png = Buffer.from(await icon.arrayBuffer());
    // PNG IHDR: width and height, big-endian, at bytes 16 and 20.
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([64, 64]);
    expect((await fetch(base + "/icon.svg")).status).toBe(404);
    await ctx.close();
  });
});

// ---------------------------------------------------------------- Stage B, past the gate

const SHOTS = process.env["E2E_SCREENSHOT_DIR"];

async function unlocked(viewport?: { width: number; height: number }): Promise<{ ctx: BrowserContext; page: Page; watch: Watch }> {
  const w = await watched();
  if (viewport !== undefined) await w.page.setViewportSize(viewport);
  await w.page.goto(base + "/gate");
  await w.page.fill("#passcode", PASSCODE);
  await Promise.all([w.page.waitForURL(`${base}/live`), w.page.click("button[type=submit]")]);
  return w;
}

const iso = (offsetS: number) => new Date(Date.now() + offsetS * 1000).toISOString();

/** A run written straight into the console's database, as the worker would have left it. */
async function seedRun(pg: PGlite, id: string, status: string, events: Array<{ s: number; kind: string; step?: string; data?: unknown }>, opts: { startedS?: number; heartbeatS?: number; reason?: string } = {}) {
  const started = opts.startedS ?? -120;
  await pg.query(
    `insert into public.console_runs (id, kind, plan_source, plan_id, scenario_sha256, session_hash, ip_hash, status, halt_reason, created_at, started_at, heartbeat_at, finished_at)
     values ($1, 'scenario', 'recorded', 'plan-e2e', $2, $3, $3, $4, $5, $6, $6, $7, $8)`,
    [id, "a".repeat(64), "b".repeat(64), status, opts.reason ?? null, iso(started), iso(opts.heartbeatS ?? -1), ["complete", "halted", "abandoned", "failed"].includes(status) ? iso(-1) : null],
  );
  for (const e of events) {
    await pg.query("insert into public.console_run_events (run_id, at, kind, step_id, data) values ($1, $2, $3, $4, $5::jsonb)", [
      id,
      iso(started + e.s),
      e.kind,
      e.step ?? null,
      JSON.stringify(e.data ?? {}),
    ]);
  }
}

/** A fixture written as the worker would have, timed so that now is nowS seconds into the run. */
async function seedFixture(pg: PGlite, id: string, f: Fixture, nowS: number) {
  const startMs = Date.now() - nowS * 1000;
  const finished = ["complete", "halted", "abandoned", "failed"].includes(f.status);
  await pg.query(
    `insert into public.console_runs (id, kind, plan_source, plan_id, scenario_sha256, session_hash, ip_hash, status, halt_reason, created_at, started_at, heartbeat_at, finished_at)
     values ($1, 'scenario', 'recorded', 'plan-20261023193216', $2, $3, $3, $4, $5, $6, $6, $7, $8)`,
    [id, "a".repeat(64), "b".repeat(64), f.status, f.reason ?? null, new Date(startMs).toISOString(), iso(-1), finished ? iso(-1) : null],
  );
  for (const e of absolute(f, startMs)) {
    await pg.query("insert into public.console_run_events (run_id, at, kind, step_id, data) values ($1, $2, $3, $4, $5::jsonb)", [id, e.at, e.kind, e.step_id, JSON.stringify(e.data)]);
  }
}

const noSideScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

describe("the live builder, past the gate", () => {
  it("hydrates, passes Tiny Bakery (R-043), and blocks the dispute plan on an empty bank", async () => {
    const { ctx, page, watch } = await unlocked();
    await expectCleanPage(page, watch, "/live", 200);
    await page.waitForFunction(() => document.querySelector(".dry")?.textContent?.includes("487 s"));
    await expect(page.locator(".dry").innerText()).resolves.toContain("PayPal still delivers this account's events to every webhook registered on it");
    await expect(page.locator(".dry").innerText()).resolves.not.toContain("per-step cap");
    await expect(page.locator(".go .btn-primary").isDisabled()).resolves.toBe(false);
    await page.locator(".plan-option", { hasText: "Open Dispute" }).click();
    await page.waitForFunction(() => document.querySelector(".dry")?.textContent?.includes("BLOCKED"));
    await expect(page.locator(".go .btn-primary").isDisabled()).resolves.toBe(true);
    if (SHOTS !== undefined) await page.screenshot({ path: join(SHOTS, "live-builder-1440.png"), fullPage: true });
    expect(watch.problems).toEqual([]);
    await ctx.close();
  });

  it("enables Run for the dispute plan once the bank holds a purchase, bound to the plan's digest", async () => {
    await db.pg.exec(`insert into public.console_purchases (order_id, capture_id, buyer_transaction_id, amount, currency, created_at)
                      values ('O-E2E-1', 'C-E2E-1', 'T-E2E-1', '25.00', 'USD', now())`);
    const { ctx, page, watch } = await unlocked({ width: 390, height: 844 });
    await page.locator(".plan-option", { hasText: "Open Dispute" }).click();
    await page.waitForFunction(() => document.querySelector(".dry")?.textContent?.includes("draws 1 of 1"));
    await expect(page.locator(".go .btn-primary").isEnabled()).resolves.toBe(true);
    await expect(page.locator("#go-note").innerText()).resolves.toContain("Sends the plan id and its fingerprint.");
    // The 64-character fingerprint sits behind Details, never in the plan a person reads.
    await expect(page.locator(".dry .json .digest").isVisible()).resolves.toBe(false);
    expect(await noSideScroll(page)).toBe(true);
    if (SHOTS !== undefined) await page.screenshot({ path: join(SHOTS, "live-builder-390.png"), fullPage: true });
    expect(watch.problems).toEqual([]);
    await ctx.close();
  });
});

describe("the live run, past the gate", () => {
  it("draws a complete run: one row per step, the reply on the same row, answer first", async () => {
    await seedFixture(db.pg, "20261025180000-e2e001", tinyBakery(40), 41);
    for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
      const { ctx, page, watch } = await unlocked(viewport);
      await expectCleanPage(page, watch, "/live/20261025180000-e2e001", 200);
      await page.waitForSelector(".step");
      await expect(page.locator("#run-h").innerText()).resolves.toBe("All 5 steps done.");
      await expect(page.locator(".run-hero .lead").innerText()).resolves.toBe("4 of 4 expected events arrived, all verified.");
      expect(await page.locator(".step").count()).toBe(5);
      // The call and PayPal's reply share one card.
      const first = page.locator(".step").first();
      await expect(first.locator(".sent-title").innerText()).resolves.toBe("Payment captured");
      await expect(first.locator(".back").innerText()).resolves.toContain("Payment completed");
      await expect(first.locator(".pill").innerText()).resolves.toBe("Arrived 12s after the call");
      await expect(page.locator(".step.compact").innerText()).resolves.toContain("No PayPal event is tied to this kind of step.");
      await expect(page.locator(".other").innerText()).resolves.toContain("INVOICING.INVOICE.UPDATED");
      expect(await page.locator(".nodes li.in").count()).toBe(4);
      // Step 3's invoice event beat step 2's payment in this fixture, and the strip says so.
      await expect(page.locator(".proof-order").innerText()).resolves.toBe("Step 3's webhook arrived before step 2's. Webhooks can arrive out of order, as here; your app has to handle that.");
      await expect(page.locator(".nodes li.in .node-label").first().innerText()).resolves.toBe("Step 1, payment");
      expect(await noSideScroll(page)).toBe(true);
      await ctx.close();
    }
  });

  // The 2026-11-07 run: a 401 on the token, nothing sent, and a banner that says so.
  it("says a run stopped at step 1 in plain words, with the code kept in Details", async () => {
    await seedFixture(db.pg, "20261025180000-e2e006", tokenRefused(), 3);
    const { ctx, page, watch } = await unlocked();
    await expectCleanPage(page, watch, "/live/20261025180000-e2e006", 200);
    await page.waitForSelector(".step.failed");
    await expect(page.locator("#run-h").innerText()).resolves.toBe("Stopped at step 1.");
    await expect(page.locator(".run-hero .lead").innerText()).resolves.toBe("PayPal refused the seller app's login (its client id and secret do not match a sandbox app). Nothing was sent.");
    const body = await page.locator("main").innerText();
    expect(body).not.toMatch(/handler threw|Every step has run|may have written/);
    await page.locator(".step.failed summary").click();
    await expect(page.locator(".step.failed .details-body").innerText()).resolves.toContain("invalid_client");
    await ctx.close();
  });

  it("while running, shows one line per step; a click opens the full card with its dashed, counting connector", async () => {
    await seedFixture(db.pg, "20261025180000-e2e002", recordedAt(RUNS[1]!, 10), 10);
    const { ctx, page, watch } = await unlocked();
    await expectCleanPage(page, watch, "/live/20261025180000-e2e002", 200);
    await page.waitForSelector(".step.line");
    await expect(page.locator("#run-h").innerText()).resolves.toBe("Running step 2 of 2: Ask PayPal to resend an event.");
    expect(await page.locator(".step.line").count()).toBe(2);
    expect(await page.locator(".step-card").count()).toBe(0);
    await expect(page.locator(".step.line").first().locator(".line-pill").innerText()).resolves.toMatch(/^\d+s so far$/);
    await expect(page.locator(".now-panel").innerText()).resolves.toContain("Step 2 of 2");
    await page.locator(".step.line").first().locator(".line-row").click();
    await page.waitForSelector(".conn.dashed");
    await expect(page.locator(".step").first().locator(".back").innerText()).resolves.toContain("Waiting for PayPal's webhook");
    expect(await page.locator(".step.current").count()).toBe(1);
    await page.locator(".line-close").click();
    expect(await page.locator(".step-card").count()).toBe(0);
    expect(watch.problems).toEqual([]);
    await db.pg.exec("update public.console_runs set status = 'complete', finished_at = now() where id = '20261025180000-e2e002'");
    await ctx.close();
  });

  it("says plainly when the server died with a step in flight, and that nothing will retry it", async () => {
    await seedRun(db.pg, "20261025180000-e2e003", "abandoned", [{ s: 0, kind: "run_started" }, { s: 2, kind: "step_started", step: "dispute", data: { kind: "open_dispute", attempt: 1 } }], {
      reason: "the server running this stopped; a step it had started may have written to PayPal",
    });
    const { ctx, page, watch } = await unlocked();
    await expectCleanPage(page, watch, "/live/20261025180000-e2e003", 200);
    await page.waitForSelector(".step");
    await expect(page.locator("#run-h").innerText()).resolves.toBe("The server running this stopped.");
    await expect(page.locator(".step").innerText()).resolves.toMatch(/Outcome never recorded[\s\S]*may have written to PayPal; nothing here will retry it/);
    await ctx.close();
  });

  it("answers an unknown run with a page that says so, and a malformed id with a 404", async () => {
    const { ctx, page, watch } = await unlocked();
    const res = await page.goto(base + "/live/20261025180000-ffffff", { waitUntil: "load" });
    expect(res?.status()).toBe(200);
    await hydrated(page);
    await page.waitForSelector(".terminal");
    await expect(page.locator(".terminal h2").innerText()).resolves.toBe("No such run");
    // The poll's own 404 is the answer, and Chrome logs it; nothing else may appear.
    const expected = `console.error: Failed to load resource: the server responded with a status of 404 (Not Found) @ ${base}/api/runs/20261025180000-ffffff?after=0`;
    expect(watch.problems.filter((p) => p !== expected)).toEqual([]);
    const bad = await page.goto(base + "/live/not-a-run");
    expect(bad?.status()).toBe(404);
    await ctx.close();
  });

  it("sends anyone without a session to the gate", async () => {
    const { ctx, page } = await watched();
    await page.goto(base + "/live/20261025180000-e2e001");
    expect(page.url()).toBe(base + "/gate");
    await ctx.close();
  });
});

describe("a replay is drawn by the live run's own view", () => {
  it("plays the recorded run to its verdict, with the same step cards", async () => {
    const { ctx, page, watch } = await watched({ reducedMotion: "reduce" });
    await expectCleanPage(page, watch, "/runs/20261023231552-60ea96", 200);
    // The finder's verdict leads, in red, never a green "Done" above a BUG.
    await expect(page.locator("#run-h").innerText()).resolves.toBe("BUG: one payment event was fulfilled twice.");
    await expect(page.locator(".run-hero .hero-badge").innerText()).resolves.toBe("BUG");
    expect(await page.locator(".step").count()).toBe(2);
    await expect(page.locator(".step").nth(1).locator(".back").innerText()).resolves.toContain("the store fulfilled the order a second time");
    await expect(page.locator(".verdict-card").innerText()).resolves.toContain("BUG");
    await ctx.close();
  });
});

// Brief v0.7.1: the Now running panel, driven by the hosted run's own recorded rows.
describe("the Now running panel", () => {
  const panelTop = (page: Page) => page.evaluate(() => Math.round(document.querySelector(".now-panel")!.getBoundingClientRect().top + scrollY));

  it.each([{ width: 1440, height: 900 }, { width: 390, height: 844 }])("holds still and sticky while the hosted replay runs, then lets go at $width", async (viewport) => {
    const { ctx, page, watch } = await watched();
    await page.setViewportSize(viewport);
    await expectCleanPage(page, watch, `/runs/${HOSTED.runId}`, 200);
    await page.getByRole("radio", { name: "8x" }).click();
    const tops = new Set<number>();
    const keys: string[] = [];
    for (let i = 0; i < 40; i++) {
      if ((await page.locator(".run.is-running").count()) === 0) break;
      tops.add(await panelTop(page));
      const word = await page.locator(".now-panel .np-body:not(.np-leave)").innerText();
      if (keys.at(-1) !== word.split("\n")[0]) keys.push(word.split("\n")[0]!);
      await page.waitForTimeout(100);
    }
    // Nothing above the panel moves it while the run can change.
    expect([...tops]).toHaveLength(1);
    expect(keys[0]).toMatch(/^(Step 1 of 5|Not started)$/);
    // Sticky under the top of the window while running.
    await page.evaluate(() => scrollTo(0, 1600));
    await page.waitForTimeout(50);
    const stuck = await page.evaluate(() => document.querySelector(".now-panel")!.getBoundingClientRect().top);
    expect(stuck).toBeLessThanOrEqual(12);
    expect(stuck).toBeGreaterThanOrEqual(8);
    expect(await noSideScroll(page)).toBe(true);
    await page.getByRole("button", { name: "Show the end" }).click();
    await expect(page.locator(".now-panel").innerText()).resolves.toContain("All 5 steps done. 4 of 4 webhooks arrived, all verified.");
    expect(await page.locator(".now-panel.sticky").count()).toBe(0);
    expect(await page.locator(".step-card").count()).toBe(5);
    expect(watch.problems).toEqual([]);
    await ctx.close();
  });

  it("names the UNPAID event, under Other events, by the invoice it shares with step 3", async () => {
    const { ctx, page, watch } = await watched({ reducedMotion: "reduce" });
    await expectCleanPage(page, watch, `/runs/${HOSTED.runId}`, 200);
    const other = await page.locator(".other").innerText();
    expect(other).toContain("PayPal says the invoice is awaiting payment");
    expect(other).toContain("Same invoice as step 3 (INV2-9V88-U4GQ-W3KB-Y4NY)");
    expect(other).toContain("INVOICING.INVOICE.UNPAID");
    expect(other).not.toContain("no plain name");
    // The two invoice events it does join sit on their own steps.
    await expect(page.locator('[data-step="invoice-1"] .back').innerText()).resolves.toContain("Invoice created");
    await expect(page.locator('[data-step="invoice-1-payment"] .back').innerText()).resolves.toContain("Invoice paid");
    await ctx.close();
  });

  it("with reduced motion, swaps at once: nothing slides, fades or pulses", async () => {
    const { ctx, page, watch } = await watched({ reducedMotion: "reduce" });
    await expectCleanPage(page, watch, `/runs/${HOSTED.runId}`, 200);
    // Reduced motion opens on the end; play it from the start at 32x.
    await page.getByRole("radio", { name: "32x" }).click();
    await page.getByRole("button", { name: "Replay from the start" }).click();
    let leaving = 0;
    const animations = new Set<string>();
    for (let i = 0; i < 25; i++) {
      leaving += await page.locator(".np-leave:visible").count();
      for (const a of await page.locator(".now-panel *").evaluateAll((els) => {
        // React may have replaced a node since it was found; a detached one has no computed style.
        const live = els.filter((e) => e.isConnected);
        return live.map((e) => getComputedStyle(e).animationName).concat(live.map((e) => getComputedStyle(e, "::after").animationName));
      })) animations.add(a);
      await page.waitForTimeout(80);
    }
    expect(leaving).toBe(0);
    expect([...animations]).toEqual(["none"]);
    expect(watch.problems).toEqual([]);
    await ctx.close();
  });

  it("past the gate, a live run fed the hosted run's rows shows the same panel", async () => {
    await seedFixture(db.pg, "20261107230012-e2e071", hostedAt(HOSTED, 7.6), 7.6);
    const { ctx, page, watch } = await unlocked();
    await expectCleanPage(page, watch, "/live/20261107230012-e2e071", 200);
    await page.waitForSelector(".now-panel.now-step");
    await expect(page.locator(".now-panel").innerText()).resolves.toMatch(/2 of 5 accepted, 0 of 4 verified[\s\S]*Step 3 of 5[\s\S]*Creating the invoice, USD 120/);
    expect(await page.locator(".now-panel.sticky").count()).toBe(1);
    await db.pg.exec("update public.console_runs set status = 'complete', finished_at = now() where id = '20261107230012-e2e071'");
    await ctx.close();
  });
});

describe("the hosted finder, past the gate", () => {
  it("lists the four hosted classes and enables Run this class", async () => {
    const { ctx, page, watch } = await unlocked();
    await page.getByRole("radio", { name: "Find an edge case" }).click();
    await expect(page.locator(".plan-option").count()).resolves.toBe(4);
    await expect(page.locator(".go .btn-primary").innerText()).resolves.toBe("Run this class");
    await expect(page.locator(".go .btn-primary").isEnabled()).resolves.toBe(true);
    expect(watch.problems).toEqual([]);
    await ctx.close();
  });

  it("shows a finder run's verdict with its evidence, as the lab report does", async () => {
    await db.pg.query(
      `insert into public.console_runs (id, kind, plan_source, plan_id, scenario_sha256, session_hash, ip_hash, status, created_at, started_at, heartbeat_at, finished_at)
       values ('20261025180000-e2e004', 'finder', 'finder', 'overdue-invoice', null, $1, $1, 'complete', now(), now(), now(), now())`,
      ["b".repeat(64)],
    );
    await db.pg.query(
      `insert into public.console_run_events (run_id, kind, data) values ('20261025180000-e2e004', 'note', $1::jsonb)`,
      [JSON.stringify({ finding: { class_id: "overdue-invoice", verdict: "ok", title: "An invoice already past its due date", expected: "the invoice to read as overdue", actual: "sent; PayPal reads it as OVERDUE", likely_fix: "none needed", skipped: null } })],
    );
    const { ctx, page, watch } = await unlocked();
    await expectCleanPage(page, watch, "/live/20261025180000-e2e004", 200);
    await page.waitForSelector(".finding");
    await expect(page.locator(".finding").innerText()).resolves.toMatch(/OK[\s\S]*An invoice already past its due date[\s\S]*Observed[\s\S]*OVERDUE/);
    if (SHOTS !== undefined) await page.screenshot({ path: join(SHOTS, "live-finder-1440.png"), fullPage: true });
    await ctx.close();
  });
});

// Brief v0.7.4 (R-053): items 1, 2, 3 and 6 as a browser draws them, and its three screenshots when E2E_SCREENSHOT_DIR is set.
describe("v0.7.4, past the gate", () => {
  const sizes = [{ width: 1440, height: 900 }, { width: 390, height: 844 }];
  let n = 0;
  const nextId = () => `20261108033057-e74${String(++n).padStart(3, "0")}`;
  const save = (page: Page, name: string, w: number, full = true) => (SHOTS === undefined ? Promise.resolve() : page.screenshot({ path: join(SHOTS, `${name}-${w}.png`), fullPage: full }));

  it("item 2: a resend mid-wait counts its seconds and says why, in the panel and on its card", async () => {
    for (const v of sizes) {
      const id = nextId();
      await seedFixture(db.pg, id, recordedAt(RUNS[1]!, 45), 45);
      const { ctx, page, watch } = await unlocked(v);
      await expectCleanPage(page, watch, `/live/${id}`, 200);
      await page.waitForSelector(".np-note");
      const note = "PayPal lists a new event before it allows a resend. This usually takes 1 to 2 minutes.";
      await expect(page.locator(".np-note").innerText()).resolves.toBe(note);
      const stage = page.locator(".np-stage-item.now").first();
      const first = await stage.innerText();
      expect(first).toMatch(/Sending(?: to PayPal)?, \d+s/);
      // The clock moves on its own between polls, so the step never looks frozen.
      await page.waitForTimeout(2200);
      expect(await stage.innerText()).not.toBe(first);
      // The note sits inside the panel's content box, never clipped and never in its padding.
      const box = await page.locator(".now-panel").boundingBox();
      const noteBox = await page.locator(".np-note").boundingBox();
      const padBottom = await page.locator(".now-panel").evaluate((el) => parseFloat(getComputedStyle(el).paddingBottom));
      expect(noteBox!.y + noteBox!.height).toBeLessThanOrEqual(box!.y + box!.height - padBottom + 1);
      await expect(page.locator(".step.line").nth(1).locator(".line-pill").innerText()).resolves.toMatch(/^Calling PayPal, \d+s$/);
      await page.locator(".step.line").nth(1).locator(".line-row").click();
      await expect(page.locator(".step").nth(1).locator(".sent-note").innerText()).resolves.toBe(note);
      await page.locator(".line-close").click();
      expect(await noSideScroll(page)).toBe(true);
      await page.evaluate(() => window.scrollTo(0, 0));
      await save(page, "resend-mid-wait", v.width, false);
      await db.pg.exec(`update public.console_runs set status = 'complete', finished_at = now() where id = '${id}'`);
      await ctx.close();
    }
  });

  it("items 1, 3, 4, 5 and 8: a finished dispute run flags PayPal's other capture in amber, and never says waiting", async () => {
    for (const v of sizes) {
      const id = nextId();
      await seedFixture(db.pg, id, disputeRun(210, "E2E-CAPTURE-OTHER-9"), 210);
      const { ctx, page, watch } = await unlocked(v);
      await expectCleanPage(page, watch, `/live/${id}`, 200);
      await page.waitForSelector(".step .pairing");
      await expect(page.locator("#run-h").innerText()).resolves.toBe("The step is done.");
      // Item 6's card: the finished sentence is shown whole, never clamped.
      await expect(page.locator(".now-panel .np-main").evaluate((el) => el.scrollHeight <= el.clientHeight + 1)).resolves.toBe(true);
      await expect(page.locator(".now-panel .np-main").innerText()).resolves.toBe("The step is done. 0 of 1 webhook arrived before the run ended, 0 verified.");
      const pairing = page.locator(".step .pairing");
      await expect(pairing.innerText()).resolves.toContain("pairing_mismatch: banked capture E2E-CAPTURE-BANK-1, PayPal says E2E-CAPTURE-OTHER-9");
      // Amber: the waiting tokens, never the bug red.
      const colors = await pairing.evaluate((el) => {
        const s = getComputedStyle(el);
        const raw = getComputedStyle(el.querySelector(".pairing-raw")!);
        return { bg: s.backgroundColor, border: s.borderTopColor, raw: raw.color };
      });
      expect(colors).toEqual({ bg: "rgb(253, 243, 220)", border: "rgb(240, 176, 58)", raw: "rgb(138, 90, 0)" });
      expect(await page.locator(".step .problem").count()).toBe(0);
      const figures = await page.locator(".figures").innerText();
      expect(figures).toMatch(/Slowest arrival\s+none arrived/);
      expect(figures).not.toMatch(/waiting/i);
      expect(figures).toMatch(/Amount in calls\s+USD 88 disputed/);
      await expect(page.locator(".step .back").innerText()).resolves.toContain("Not proof it never came: In our sandbox runs, dispute events arrived about 3 minutes after filing, and once 12 hours later.");
      expect(await noSideScroll(page)).toBe(true);
      await save(page, "dispute-finished", v.width);
      await ctx.close();
    }
  });

  it("item 6: the finder result's finished panel fits its content, with no blank band under the sentence", async () => {
    for (const v of sizes) {
      const id = nextId();
      // A recorded finder run with its steps and its verdict, as a hosted finder run is shown.
      const ok = RUNS.find((r) => r.verdict === "ok")!;
      await seedFixture(db.pg, id, recordedAt(ok, replayEndS(ok) + 1), replayEndS(ok) + 2);
      await db.pg.query("update public.console_runs set kind = 'finder', plan_source = 'finder', plan_id = $2 where id = $1", [id, ok.finding.classId]);
      const { ctx, page, watch } = await unlocked(v);
      await expectCleanPage(page, watch, `/live/${id}`, 200);
      await page.waitForSelector(".finding");
      const gap = await page.evaluate(() => {
        const panel = document.querySelector(".now-panel")!.getBoundingClientRect();
        const content = document.querySelector(".now-panel .np-content")!.getBoundingClientRect();
        return panel.bottom - content.bottom;
      });
      // Only the panel's own bottom padding (20px at 1440, 18px at 390) is left under the content.
      expect(gap).toBeLessThanOrEqual(24);
      expect(await noSideScroll(page)).toBe(true);
      await save(page, "finder-result", v.width);
      await ctx.close();
    }
  });
});

// Brief v0.7.5 (R-054): items 1 and 4 as a browser draws them, and their screenshots when E2E_SCREENSHOT_DIR is set.
describe("v0.7.5, the dispute wait and the out-of-order replay", () => {
  const sizes = [{ width: 1440, height: 900 }, { width: 390, height: 844 }];
  let n = 0;
  const nextId = () => `20261108120000-e75${String(++n).padStart(3, "0")}`;
  const save = (page: Page, name: string, w: number, full = true) => (SHOTS === undefined ? Promise.resolve() : page.screenshot({ path: join(SHOTS, `${name}-${w}.png`), fullPage: full }));

  it("item 1: a dispute run mid-wait says when dispute events usually arrive, and names its 270 s wait", async () => {
    for (const v of sizes) {
      const id = nextId();
      // 88.5 s into the 270 s wait that follows the dispute step.
      await seedFixture(db.pg, id, disputeRun(200, undefined, 270), 200);
      const { ctx, page, watch } = await unlocked(v);
      await expectCleanPage(page, watch, `/live/${id}`, 200);
      await page.waitForSelector(".now-panel .np-note");
      await expect(page.locator(".now-panel .np-note").innerText()).resolves.toBe("Dispute events usually arrive about 3 minutes after the dispute is filed.");
      await expect(page.locator(".now-panel .np-main").innerText()).resolves.toBe("Waiting for PayPal's webhooks: 0 of 1 arrived");
      // The note sits inside the panel's content box, never clipped and never in its padding.
      const box = await page.locator(".now-panel").boundingBox();
      const noteBox = await page.locator(".now-panel .np-note").boundingBox();
      const padBottom = await page.locator(".now-panel").evaluate((el) => parseFloat(getComputedStyle(el).paddingBottom));
      expect(noteBox!.y + noteBox!.height).toBeLessThanOrEqual(box!.y + box!.height - padBottom + 1);
      await page.locator(".step.line").first().locator(".line-row").click();
      await expect(page.locator(".step .foot-note").first().innerText()).resolves.toBe("It shows here the moment the store records it. The run listens for 270 s after its last step.");
      await page.locator(".line-close").click();
      expect(await noSideScroll(page)).toBe(true);
      await page.evaluate(() => window.scrollTo(0, 0));
      await save(page, "dispute-mid-wait", v.width, false);
      await db.pg.exec(`update public.console_runs set status = 'complete', finished_at = now() where id = '${id}'`);
      await ctx.close();
    }
  });

  it("item 4: the c0a4d0 replay states, in plain words, that PayPal's webhooks arrived out of order", async () => {
    const ooo = HOSTED_REPLAYS.find((h) => h.runId === "20261108005357-c0a4d0")!;
    for (const v of sizes) {
      const { ctx, page, watch } = await watched({ reducedMotion: "reduce" });
      await page.setViewportSize(v);
      await expectCleanPage(page, watch, "/runs", 200);
      await expect(page.locator(`a[href="/runs/${ooo.runId}"] .rc-name`).innerText()).resolves.toBe("Tiny Bakery, webhooks out of order");
      await expectCleanPage(page, watch, `/runs/${ooo.runId}`, 200);
      await hydrated(page);
      await expect(page.locator("#run-h").innerText()).resolves.toBe("All 5 steps done.");
      await expect(page.locator(".proof-order").innerText()).resolves.toBe("Step 2's webhook arrived before step 1's. Webhooks can arrive out of order, as here; your app has to handle that.");
      const banner = await page.locator(".replay-banner").innerText();
      expect(banner).toContain("PayPal delivered step 2's payment webhook before step 1's, and the invoice's UNPAID event before its CREATED event.");
      // The finished panel's note says the same and is never cut short, at either width.
      const note = page.locator(".now-panel .np-text").last();
      await expect(note.innerText()).resolves.toContain("Step 2's webhook arrived before step 1's.");
      await expect(note.evaluate((el) => el.scrollHeight <= el.clientHeight + 1)).resolves.toBe(true);
      expect(await noSideScroll(page)).toBe(true);
      await save(page, "replay-out-of-order", v.width);
      await ctx.close();
    }
  });
});

// v0.7.6: a reply that takes minutes ("Arrived 3m 10s after the call") must not run into the reply column.
// Live run 20261110051621-6c2e39 on 2026-11-10 drew the pill over "Arrived / Dispute opened" at 1920 wide,
// because the middle column was a fixed 200 px and the pill never wraps.
describe("v0.7.6, a slow reply's pill keeps clear of both columns", () => {
  it("a dispute that arrives 3m 10s after its call: the pill sits between the columns at every desktop width", async () => {
    const banked = "E2E-CAPTURE-BANK-1";
    const f = disputeRun(400, banked, 270);
    const events = [...f.events, {
      s: 301,
      kind: "delivery",
      data: { event_id: "WH-E2E-DISPUTE-1", event_type: "CUSTOMER.DISPUTE.CREATED", deliveries: 1, fulfilled: 0, duplicates_ignored: 0, other: 1, refused: 0, cert_hosts: ["api.sandbox.paypal.com"], capture_ids: [banked], received_at: [{ rel: 301 }] },
    }].sort((a, b) => a.s - b.s);
    let n = 0;
    for (const v of [{ width: 1920, height: 1080 }, { width: 1440, height: 900 }, { width: 1000, height: 800 }]) {
      const id = `20261110120000-e76${String(++n).padStart(3, "0")}`;
      await seedFixture(db.pg, id, { ...f, events }, 400);
      const { ctx, page, watch } = await unlocked(v);
      await expectCleanPage(page, watch, `/live/${id}`, 200);
      await page.waitForSelector(".step .mid .pill");
      const pill = page.locator(".step .mid .pill").first();
      await expect(pill.innerText()).resolves.toBe("Arrived 3m 10s after the call");
      const pillBox = (await pill.boundingBox())!;
      const backBox = (await page.locator(".step .row .back").first().boundingBox())!;
      const sentBox = (await page.locator(".step .row > :first-child").first().boundingBox())!;
      // At least 12 px of air on each side of the pill.
      expect(pillBox.x + pillBox.width).toBeLessThanOrEqual(backBox.x - 12);
      expect(pillBox.x).toBeGreaterThanOrEqual(sentBox.x + sentBox.width + 12);
      expect(await noSideScroll(page)).toBe(true);
      if (SHOTS !== undefined) {
        await page.locator(".step").first().scrollIntoViewIfNeeded();
        await page.screenshot({ path: join(SHOTS, `slow-reply-pill-${v.width}.png`) });
      }
      await ctx.close();
    }
  });
});

// The D2 build screenshots (brief v0.7.0, section 6, and v0.7.1, section 7), when E2E_SCREENSHOT_DIR is set.
describe.runIf(SHOTS !== undefined)("D2 screenshots at 1440 and 390", () => {
  const sizes = [{ width: 1440, height: 900 }, { width: 390, height: 844 }];
  const shot = (page: Page, name: string, w: number) => page.screenshot({ path: join(SHOTS!, `${name}-${w}.png`), fullPage: true });

  // Brief v0.7.1 section 7: the panel in each state, the list while running, the wordmark, the replay list.
  it("v0.7.1: the Now running panel, from the hosted run's own rows", async () => {
    const states: ReadonlyArray<readonly [string, () => Fixture, number]> = [
      ["panel-card-step", () => hostedAt(HOSTED, 2), 2],
      ["panel-invoice-step", () => hostedAt(HOSTED, 7.6), 7.6],
      ["panel-webhooks", () => hostedAt(HOSTED, 30), 30],
      ["panel-final-complete", () => hostedAt(HOSTED, 200), 101],
      ["panel-final-halted", () => tokenRefused(), 3],
    ];
    let n = 0;
    for (const v of sizes) {
      const { ctx, page } = await unlocked(v);
      for (const [name, make, nowS] of states) {
        const id = `20261107120000-d71${String(++n).padStart(3, "0")}`;
        const f = make();
        await seedFixture(db.pg, id, f, nowS);
        await page.goto(`${base}/live/${id}`, { waitUntil: "load" });
        await page.waitForSelector(".now-panel");
        await page.waitForTimeout(500);
        expect(await noSideScroll(page), `${name} at ${v.width}`).toBe(true);
        // The panel and what is around it, as a judge sees it on landing.
        await page.screenshot({ path: join(SHOTS!, `${name}-${v.width}.png`) });
        if (name === "panel-webhooks") await shot(page, "compact-list-running", v.width);
        if (f.status === "running") await db.pg.exec(`update public.console_runs set status = 'complete', finished_at = now() where id = '${id}'`);
      }
      await ctx.close();
    }
  });

  it("v0.7.1: the wordmark and the hosted replay list", async () => {
    for (const v of sizes) {
      const { ctx, page } = await watched({ reducedMotion: "reduce" });
      await page.setViewportSize(v);
      await page.goto(base + "/runs", { waitUntil: "networkidle" });
      await hydrated(page);
      await shot(page, "replays-hosted", v.width);
      await page.screenshot({ path: join(SHOTS!, `wordmark-${v.width}.png`), clip: { x: 0, y: 0, width: v.width, height: v.width === 390 ? 100 : 64 } });
      await ctx.close();
    }
  });

  // Frames of one replay through the panel, on its recorded clock at 1x, for review of the motion.
  it("v0.7.1: frames of the hosted replay through the panel", async () => {
    const { ctx, page } = await watched();
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${base}/runs/${HOSTED.runId}`, { waitUntil: "load" });
    await hydrated(page);
    const start = Date.now();
    // Recorded seconds: step 1 sending; mid-swap from step 1 to 2 (call finished at 3.68 s);
    // the invoice step; webhooks 0 of 4; 1 of 4; 2 of 4; all 4 in and listening; then the end.
    const moments = [1.5, 3.9, 7.6, 12, 15.5, 28, 39];
    for (const [i, t] of moments.entries()) {
      await page.waitForTimeout(Math.max(0, t * 1000 - (Date.now() - start)));
      await page.screenshot({ path: join(SHOTS!, "replay-frames", `frame-${i + 1}-${String(t).replace(".", "_")}s.png`) });
    }
    await page.getByRole("button", { name: "Show the end" }).click();
    await page.waitForTimeout(500);
    await page.screenshot({ path: join(SHOTS!, "replay-frames", `frame-${moments.length + 1}-end.png`) });
    await ctx.close();
  }, 60_000);

  it("v0.7.3: bug and OK replays, hosted replay finished, live panel mid-run, dry run, /build", async () => {
    const dir = SHOTS!;
    mkdirSync(dir, { recursive: true });
    const save = (page: Page, name: string, w: number, full = true) => page.screenshot({ path: join(dir, `${name}-${w}.png`), fullPage: full });
    const [bug, ok] = [RUNS.find((r) => r.verdict === "bug")!, RUNS.find((r) => r.verdict === "ok")!];
    for (const v of sizes) {
      for (const [name, path] of [["replay-bug-verdict", `/runs/${bug.runId}`], ["replay-ok-verdict", `/runs/${ok.runId}`], ["replay-hosted-finished", `/runs/${HOSTED.runId}`], ["build", "/build"]] as const) {
        const { ctx, page } = await watched({ reducedMotion: "reduce" });
        await page.setViewportSize(v);
        await page.goto(base + path, { waitUntil: "networkidle" });
        await hydrated(page);
        expect(await noSideScroll(page), `${path} at ${v.width}`).toBe(true);
        if (name === "replay-bug-verdict") await expect(page.locator("#run-h").innerText()).resolves.toBe("BUG: one payment event was fulfilled twice.");
        if (name === "replay-ok-verdict") await expect(page.locator("#run-h").innerText()).resolves.toMatch(/^OK: /);
        await save(page, name, v.width);
        await ctx.close();
      }
      const { ctx, page } = await unlocked(v);
      await page.waitForFunction(() => document.querySelector(".dry .plan-steps") !== null);
      expect(await noSideScroll(page), `/live dry run at ${v.width}`).toBe(true);
      await save(page, "dry-run", v.width);
      // The hosted run's own rows at 30 s: every call done, waiting on PayPal's webhooks.
      const id = `20261107120000-d73${v.width === 1440 ? "001" : "002"}`;
      await seedFixture(db.pg, id, hostedAt(HOSTED, 30), 30);
      await page.goto(`${base}/live/${id}`, { waitUntil: "load" });
      await page.waitForSelector(".now-panel");
      await page.waitForTimeout(500);
      expect(await noSideScroll(page), `live mid-run at ${v.width}`).toBe(true);
      await save(page, "live-panel-mid-run", v.width, false);
      await db.pg.exec(`update public.console_runs set status = 'complete', finished_at = now() where id = '${id}'`);
      await ctx.close();
    }
  }, 120_000);

  it("public pages: home, plans, replays, replay run, finder, gate", async () => {
    const pages = [["home", "/"], ["plans", "/build"], ["replays", "/runs"], ["replay-run", "/runs/20261023231552-60ea96"], ["finder", "/finder"], ["gate", "/gate"]] as const;
    for (const v of sizes) {
      for (const [name, path] of pages) {
        const { ctx, page } = await watched({ reducedMotion: "reduce" });
        await page.setViewportSize(v);
        await page.goto(base + path, { waitUntil: "networkidle" });
        await hydrated(page);
        expect(await noSideScroll(page), `${path} at ${v.width}`).toBe(true);
        await shot(page, name, v.width);
        await ctx.close();
      }
    }
  });

  it("live: builder, mid-run, complete, halted", async () => {
    // The database allows one active run, so each running fixture is seeded, shot, then closed.
    const runs: ReadonlyArray<readonly [string, () => Fixture, number]> = [
      ["live-mid-run", () => tinyBakery(20), 20],
      ["live-mid-run-recorded", () => recordedAt(RUNS[1]!, 10), 10],
      ["live-complete", () => tinyBakery(40), 41],
      ["live-halted", () => tokenRefused(), 3],
    ];
    let n = 0;
    for (const v of sizes) {
      const { ctx, page } = await unlocked(v);
      await page.waitForFunction(() => document.querySelector(".dry .plan-steps") !== null);
      expect(await noSideScroll(page), `/live at ${v.width}`).toBe(true);
      await shot(page, "live-builder", v.width);
      for (const [name, make, nowS] of runs) {
        const id = `20261107120000-d2a${String(++n).padStart(3, "0")}`;
        const f = make();
        await seedFixture(db.pg, id, f, nowS);
        await page.goto(`${base}/live/${id}`, { waitUntil: "load" });
        await page.waitForSelector(".step");
        await page.waitForTimeout(400);
        expect(await noSideScroll(page), `${name} at ${v.width}`).toBe(true);
        await shot(page, name, v.width);
        if (f.status === "running") await db.pg.exec(`update public.console_runs set status = 'complete', finished_at = now() where id = '${id}'`);
      }
      await ctx.close();
    }
  });
});
