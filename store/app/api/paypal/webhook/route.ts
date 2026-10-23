import { createDb, readConfig } from "../../../../lib/db";
import { handleEvent, recordRefusal } from "../../../../lib/merchant";
import { verifySignature } from "../../../../lib/verify";

/**
 * The sample store's webhook endpoint: what a typical small merchant app does
 * when PayPal tells it something happened.
 *
 * This app is the SUBJECT of the tests, not part of the test harness. It
 * contains a deliberately planted bug, documented in lib/merchant.ts.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = ["iad1"];
export const maxDuration = 15;

const MAX_BODY_BYTES = 1_000_000;

export async function POST(req: Request): Promise<Response> {
  // Nowhere to record means do not accept the delivery. PayPal retries a
  // non-2xx, so events are delayed rather than lost.
  let config;
  try {
    config = readConfig(process.env);
  } catch (e) {
    console.error(`store db misconfigured: ${(e as Error).message}`);
    return Response.json({ ok: false }, { status: 503 });
  }
  if (config === null) {
    console.error("store db is not configured");
    return Response.json({ ok: false }, { status: 503 });
  }

  const db = createDb(config);

  // Every refusal leaves a row, so a refused delivery can never be mistaken
  // for one that did not arrive. The status sent back is the same whether or
  // not the row could be written: recording is evidence, never a way in.
  const refuse = async (status: number, reason: string): Promise<Response> => {
    try {
      await recordRefusal(db, reason);
    } catch (e) {
      console.error(`store could not record a refusal: ${(e as Error).message}`);
    }
    return Response.json({ ok: false }, { status });
  };

  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) {
    return refuse(413, `body over ${MAX_BODY_BYTES} characters`);
  }

  let event: unknown;
  try {
    event = JSON.parse(raw);
  } catch {
    return refuse(400, "body is not JSON");
  }

  // This endpoint is public, so the signature is the only thing distinguishing
  // PayPal from anyone else. An event that does not verify is recorded and
  // ignored, never acted on.
  const selfOrigin = new URL(req.url).origin;
  const { verified, detail } = await verifySignature(
    req.headers,
    event,
    process.env,
    selfOrigin,
  );

  try {
    await handleEvent(db, event, { verified, detail });
  } catch (e) {
    console.error(`store handling failed: ${(e as Error).message}`);
    return Response.json({ ok: false }, { status: 500 });
  }

  if (verified === false) {
    console.error(`store rejected an unverified event: ${detail}`);
    return Response.json({ ok: false }, { status: 401 });
  }
  if (verified === null) {
    // Cannot check, so cannot act. A non-2xx makes PayPal retry, which is what
    // should happen once the store is configured properly.
    console.error(`store could not verify an event: ${detail}`);
    return Response.json({ ok: false }, { status: 503 });
  }

  // Generic on purpose. What the store did with an event is visible through the
  // token-protected state endpoint, not to whoever posted it.
  return Response.json({ ok: true }, { status: 200 });
}

export function GET(): Response {
  return Response.json({ error: "method not allowed" }, { status: 405 });
}
