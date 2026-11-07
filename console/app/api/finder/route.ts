import { after } from "next/server";
import { dbFromEnv } from "../../../lib/db";
import { DEFAULT_PLANNER_MODEL, PaypalClient, anthropicGenerator, cleanModelText, credentialsFor, storeStateReader } from "../../../lib/engine";
import { MAX_DURATION_S } from "../../../lib/hosted";
import { handleFinderPost } from "../../../lib/live";
import { runFinderWorker } from "../../../lib/worker";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// after() keeps working up to the route's maxDuration. 800 is the Pro
// limit that is generally available; above it is beta. Never raise this.
export const maxDuration = 800;

const THROTTLE_MS = 250;
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
  const key = env["ANTHROPIC_API_KEY"]?.trim() ?? "";
  const model = env["REHEARSAL_PLANNER_MODEL"]?.trim() || DEFAULT_PLANNER_MODEL;
  return handleFinderPost(req, {
    env,
    db: dbFromEnv(env),
    now: Date.now,
    paypalReady: paypalReady(env),
    generate: key === "" ? null : anthropicGenerator({ apiKey: key, model }),
    startFinder: ({ runId, classId, config, db, generate }) => {
      const token = env["REHEARSAL_STORE_TOKEN"]?.trim() ?? "";
      // Built here, before after(): a bad credential then throws inside the
      // hand-off, which cancels the start and gives its quota back.
      const seller = new PaypalClient(credentialsFor("seller", env), { label: "seller", log, minIntervalMs: THROTTLE_MS });
      const buyer = new PaypalClient(credentialsFor("buyer", env), { label: "buyer", log, minIntervalMs: THROTTLE_MS });
      after(() =>
        runFinderWorker(
          { runId, classId },
          {
            db,
            seller,
            buyer,
            // The finder's verdict rests on the store's records; without a token it is INCONCLUSIVE.
            readStore: token.length >= MIN_STORE_TOKEN_CHARS ? storeStateReader({ origin: config.storeOrigin, token }) : null,
            now: () => new Date(),
            sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
            log,
            env,
            deadlineMs: invokedAt + (MAX_DURATION_S - DEADLINE_MARGIN_S) * 1000,
            generate,
            caps: config.caps,
            storeOrigin: config.storeOrigin,
          },
        ),
      );
    },
  });
}
