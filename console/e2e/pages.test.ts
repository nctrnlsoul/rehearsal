import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { type Browser, type BrowserContext, type Page, chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RUNS } from "../lib/replays";
import { hashFor } from "../tests/helpers";

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
  server = spawn(process.execPath, [join(ROOT, "node_modules", "next", "dist", "bin", "next"), "start", "-p", String(port), "-H", "localhost"], {
    cwd: ROOT,
    env: {
      ...process.env,
      // vitest sets NODE_ENV=test; the server under test must be production.
      NODE_ENV: "production",
      CONSOLE_PASSCODE_HASH: hashFor(PASSCODE),
      CONSOLE_SESSION_SECRET: randomBytes(32).toString("hex"),
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
    await expect(page.locator("h1").textContent()).resolves.toBe("Live runs arrive in Stage B.");
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
    await expect(page.locator("h1").textContent()).resolves.toBe("Live runs arrive in Stage B.");
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
