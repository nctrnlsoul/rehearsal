import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { anthropicGenerator, cleanModelText } from "../src/ai/planner";
import { credentialsFor } from "../src/adapters/env";
import { PaypalClient } from "../src/adapters/paypal";
import { pathsUnder } from "../src/app/runtime";
import { startServer } from "../src/mcp/server";

/**
 * REHEARSAL MCP server, stdio transport only. It runs on the
 * developer's machine with their own environment variables; nothing listens on
 * a port.
 *
 * stdout IS the protocol channel, so a stray console.log anywhere in the
 * process would corrupt it. Every console method that writes to stdout is
 * pointed at stderr before the server starts. No module this imports writes
 * at load time.
 */
console.log = console.error;
console.info = console.error;
console.debug = console.error;

const THROTTLE_MS = 300;

// The bank and run state live in the repo, wherever the client starts us from.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const log = (line: string) => process.stderr.write(`[rehearsal-mcp] ${cleanModelText(line, 300)}\n`);

await startServer(
  {
    env: process.env,
    paths: pathsUnder(root),
    makeClient: (role) =>
      new PaypalClient(credentialsFor(role, process.env), { label: role, log, minIntervalMs: THROTTLE_MS }),
    makeGenerator: (opts) => anthropicGenerator(opts),
    now: () => new Date(),
    sleep: (ms) => new Promise<void>((r) => setTimeout(r, ms)),
    log,
  },
  new StdioServerTransport(),
);
log("ready on stdio");
