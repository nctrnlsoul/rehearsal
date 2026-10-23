import { createDb, readConfig } from "../../../../lib/db";
import { handleEvent } from "../../../../lib/merchant";
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

  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) {
    return Response.json({ ok: false }, { status: 413 });
  }

  let event: unknown;
  try {
    event = JSON.parse(raw);
  } catch {
    return Response.json({ ok: false }, { status: 400 });
  }

  const { verified } = await verifySignature(req.headers, event, process.env);

  try {
    await handleEvent(createDb(config), event, { verified });
  } catch (e) {
    console.error(`store handling failed: ${(e as Error).message}`);
    return Response.json({ ok: false }, { status: 500 });
  }

  // Generic on purpose. What the store did with an event is visible through the
  // token-protected state endpoint, not to whoever posted it.
  return Response.json({ ok: true }, { status: 200 });
}

export function GET(): Response {
  return Response.json({ error: "method not allowed" }, { status: 405 });
}
