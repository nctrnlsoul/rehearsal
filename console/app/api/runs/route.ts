import { after } from "next/server";
import { dbFromEnv } from "../../../lib/db";
import { PaypalClient, cleanModelText, credentialsFor, storeStateReader } from "../../../lib/engine";
import { MAX_DURATION_S } from "../../../lib/hosted";
import { handleRunsPost } from "../../../lib/live";
import { runScenarioWorker } from "../../../lib/worker";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// after() keeps working up to the route's maxDuration. 800 is the Pro
// limit that is generally available; above it is beta. Never raise this.
export const maxDuration = 800;

/** PayPal publishes no rate limits, so the console throttles itself like the CLI. */
const THROTTLE_MS = 250;
/** Kept back from maxDuration for the worker's own last writes. */
const DEADLINE_MARGIN_S = 20;
const MIN_STORE_TOKEN_CHARS = 32;

const log = (line: string) => console.log(cleanModelText(line, 400));

function paypalReady(env: Record<string, string | undefined>): boolean {
  try {
    credentialsFor("seller", env);
    credentialsFor("buyer", env);
    return true;
  } catch {
    return false;
  }
}

export async function POST(req: Request): Promise<Response> {
  const invokedAt = Date.now();
  const env = process.env;
  return handleRunsPost(req, {
    env,
    db: dbFromEnv(env),
    now: Date.now,
    paypalReady: paypalReady(env),
    startWorker: ({ runId, scenario, digest, config, db }) => {
      const token = env["REHEARSAL_STORE_TOKEN"]?.trim() ?? "";
      if (token.length < MIN_STORE_TOKEN_CHARS) log(`run ${runId}: no usable store token, so deliveries will not be read`);
      // Built here, before after(): a bad credential then throws inside the
      // hand-off, which cancels the start and gives its quota back.
      const seller = new PaypalClient(credentialsFor("seller", env), { label: "seller", log, minIntervalMs: THROTTLE_MS });
      const buyer = new PaypalClient(credentialsFor("buyer", env), { label: "buyer", log, minIntervalMs: THROTTLE_MS });
      after(() =>
        runScenarioWorker(
          { runId, scenario, digest },
          {
            db,
            seller,
            buyer,
            readStore: token.length >= MIN_STORE_TOKEN_CHARS ? storeStateReader({ origin: config.storeOrigin, token }) : null,
            now: () => new Date(),
            sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
            log,
            env,
            deadlineMs: invokedAt + (MAX_DURATION_S - DEADLINE_MARGIN_S) * 1000,
          },
        ),
      );
    },
  });
}
