import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { PGlite } from "@electric-sql/pglite";
import { type Browser, type BrowserContext, type Page, chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RUNS } from "../lib/replays";
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
async function watched(opts: { javaScriptEnabled?: boolean } = {}): Promise<{ ctx: BrowserContext; page: Page; watch: Watch }> {
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
const PAGES = ["/", "/build", "/runs", ...RUNS.map((r) => `/runs/${r.runId}`), "/finder", "/gate"];

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
    await Promise.all([page.waitForURL(/\/gate\?e=wrong&left=\d$/), page.click("button[type=submit]")]);
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
    await Promise.all([page.waitForURL(/\/gate\?e=wrong&left=\d$/), page.click("button[type=submit]")]);
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

// R-037: the NorthSchema blossom as maker's mark, white on dark, in the header
// and favicon; the footer credit is text (vault ruling J-023).
describe("maker's mark", () => {
  it.each(PAGES)("%s shows the blossom in the header and credits NorthSchema in text below", async (path) => {
    const { ctx, page } = await watched();
    await page.goto(base + path, { waitUntil: "load" });
    const mark = await page.locator(".topbar img.maker-mark").evaluate((img: HTMLImageElement) => {
      const r = img.getBoundingClientRect();
      return { loaded: img.complete && img.naturalWidth > 0, natural: [img.naturalWidth, img.naturalHeight], height: r.height, alt: img.alt, src: new URL(img.src).pathname };
    });
    expect(mark).toEqual({ loaded: true, natural: [76, 72], height: 36, alt: "Made by NorthSchema", src: "/northschema-blossom.png" });
    expect(await page.locator("footer.site").innerText()).toMatch(/by NorthSchema$/);
    expect(await page.locator("footer.site img").count()).toBe(0);
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

const orderEvents = (capture: string, delivered: boolean) => [
  { s: 0, kind: "run_started" },
  { s: 1, kind: "step_started", step: "order", data: { kind: "card_order", attempt: 1 } },
  { s: 4, kind: "step_finished", step: "order", data: { kind: "card_order", status: "succeeded", detail: "captured USD 25.00 by card", ids: { order_id: "5O190127TN364715T", capture_id: capture } } },
  ...(delivered
    ? [
        { s: 19, kind: "note", data: { order: { capture_id: capture, fulfilled: 1, refunds: 0, disputes: 0, duplicates_ignored: 0 } } },
        { s: 19, kind: "delivery", data: { event_id: "WH-E2E-1", event_type: "PAYMENT.CAPTURE.COMPLETED", deliveries: 1, fulfilled: 1, duplicates_ignored: 0, other: 0, refused: 0, cert_hosts: ["api.sandbox.paypal.com"] } },
      ]
    : []),
];

/** Elements whose drawn color is the accent. R-026: spent on the live connector only. */
const accentElements = (page: Page) =>
  page.evaluate(() => {
    const accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim().toLowerCase();
    const probe = document.createElement("div");
    probe.style.color = accent;
    document.body.appendChild(probe);
    const rgb = getComputedStyle(probe).color;
    probe.remove();
    const hits: string[] = [];
    for (const el of document.querySelectorAll("main *")) {
      const cs = getComputedStyle(el);
      if ([cs.color, cs.stroke, cs.fill, cs.backgroundColor].includes(rgb) && el.closest("[aria-hidden=true], svg, .btn-primary") !== null) hits.push(el.tagName.toLowerCase() + "." + (el.getAttribute("class") ?? ""));
    }
    return hits;
  });

const noSideScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

describe("the live builder, past the gate", () => {
  it("hydrates, passes Tiny Bakery (R-043), and blocks the dispute plan on an empty bank", async () => {
    const { ctx, page, watch } = await unlocked();
    await expectCleanPage(page, watch, "/live", 200);
    await page.waitForFunction(() => document.querySelector(".dry")?.textContent?.includes("150 s"));
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
    await expect(page.locator("#go-note").innerText()).resolves.toMatch(/digest [0-9a-f]{12}/);
    expect(await noSideScroll(page)).toBe(true);
    if (SHOTS !== undefined) await page.screenshot({ path: join(SHOTS, "live-builder-390.png"), fullPage: true });
    expect(watch.problems).toEqual([]);
    await ctx.close();
  });
});

describe("the live timeline, past the gate", () => {
  it("draws a complete run: the order joined to its capture, the time on the connector, the delivery in the ledger", async () => {
    await seedRun(db.pg, "20261025180000-e2e001", "complete", [...orderEvents("CAP-E2E-1", true), { s: 30, kind: "deliveries_wait_started", data: { seconds: 90 } }, { s: 119, kind: "deliveries_wait_ended", data: { events_seen: 1 } }, { s: 119, kind: "run_finished", data: { status: "complete" } }]);
    for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
      const { ctx, page, watch } = await unlocked(viewport);
      await expectCleanPage(page, watch, "/live/20261025180000-e2e001", 200);
      await page.waitForSelector("path.link.verified");
      await expect(page.locator(".live-state .headline").innerText()).resolves.toContain("Complete");
      expect(await page.locator("path.link").count()).toBe(1);
      await expect(page.locator("g.pill text").first().textContent()).resolves.toBe("within 15 s");
      await expect(page.locator(".ledger").innerText()).resolves.toContain("WH-E2E-1");
      // Nothing is live any more, so the accent has left the board.
      expect(await accentElements(page)).toEqual([]);
      expect(await noSideScroll(page)).toBe(true);
      if (SHOTS !== undefined) await page.screenshot({ path: join(SHOTS, `live-complete-${viewport.width}.png`), fullPage: true });
      await ctx.close();
    }
  });

  // R-044: with the store's own receive time the connector carries an exact latency.
  it("draws an exact pair: the store's receive time on the card and an exact latency on the connector", async () => {
    await seedRun(db.pg, "20261025180000-e2e005", "complete", [
      { s: 0, kind: "run_started" },
      { s: 1, kind: "step_started", step: "order", data: { kind: "card_order", attempt: 1 } },
      { s: 5, kind: "step_finished", step: "order", data: { kind: "card_order", status: "succeeded", detail: "captured USD 25.00 by card", finished_at: iso(-120 + 4.2), ids: { capture_id: "CAP-E2E-4" } } },
      { s: 15, kind: "delivery", data: { event_id: "WH-E2E-4", event_type: "PAYMENT.CAPTURE.COMPLETED", deliveries: 1, fulfilled: 1, duplicates_ignored: 0, other: 0, refused: 0, cert_hosts: ["api.sandbox.paypal.com"], capture_ids: ["CAP-E2E-4"], received_at: [iso(-120 + 11.6)] } },
      { s: 119, kind: "run_finished", data: { status: "complete" } },
    ]);
    const { ctx, page, watch } = await unlocked();
    await expectCleanPage(page, watch, "/live/20261025180000-e2e005", 200);
    await page.waitForSelector("path.link.verified");
    await expect(page.locator("g.pill text").first().textContent()).resolves.toBe("7 s");
    await expect(page.locator(".delivery .env-head").first().innerText()).resolves.toContain("received");
    await expect(page.locator(".ledger tbody tr").first().innerText()).resolves.toContain("order");
    if (SHOTS !== undefined) await page.screenshot({ path: join(SHOTS, "live-exact-1440.png"), fullPage: true });
    expect(watch.problems).toEqual([]);
    await ctx.close();
  });

  it("draws a waiting delivery as the one live, accented connector, counting up", async () => {
    await seedRun(db.pg, "20261025180000-e2e002", "running", orderEvents("CAP-E2E-2", false), { startedS: -20 });
    const { ctx, page, watch } = await unlocked();
    await expectCleanPage(page, watch, "/live/20261025180000-e2e002", 200);
    await page.waitForSelector("path.link.waiting");
    await expect(page.locator(".delivery.waiting").innerText()).resolves.toContain("waiting on PayPal");
    const hits = await accentElements(page);
    expect(hits.length).toBeGreaterThan(0);
    for (const h of hits) expect(h).toMatch(/^(path\.link waiting|circle\.anchor live|rect\.|text\.)/);
    if (SHOTS !== undefined) await page.screenshot({ path: join(SHOTS, "live-waiting-1440.png"), fullPage: true });
    await db.pg.exec("update public.console_runs set status = 'complete', finished_at = now() where id = '20261025180000-e2e002'");
    await ctx.close();
  });

  it("says plainly when the server died with a step in flight, and that nothing will retry it", async () => {
    await seedRun(db.pg, "20261025180000-e2e003", "abandoned", [{ s: 0, kind: "run_started" }, { s: 2, kind: "step_started", step: "dispute", data: { kind: "open_dispute", attempt: 1 } }], {
      reason: "the server running this stopped; a step it had started may have written to PayPal",
    });
    const { ctx, page, watch } = await unlocked();
    await expectCleanPage(page, watch, "/live/20261025180000-e2e003", 200);
    await page.waitForSelector(".call");
    await expect(page.locator(".live-state").innerText()).resolves.toContain("The server running this stopped.");
    await expect(page.locator(".call").innerText()).resolves.toMatch(/never confirmed[\s\S]*may have written to PayPal[\s\S]*Nothing here will retry it/);
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
