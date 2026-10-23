import { createHash, timingSafeEqual } from "node:crypto";
import { BOOTED_AT_MS, INSTANCE_ID, createLedger, readConfig } from "../../../../lib/ledger";

/**
 * Read side of the arrival ledger. Requires a shared secret, because the rows
 * describe real payment events and this endpoint is public on the internet.
 *
 * The auth gate is unchanged by the move to Supabase: callers still present
 * REHEARSAL_RECEIVER_TOKEN, and the Supabase key stays server-side.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = ["iad1"];

/** Constant-time compare over fixed-length digests, so lengths cannot leak either. */
function secretsMatch(presented: string, expected: string): boolean {
  const a = createHash("sha256").update(presented, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}

export async function GET(req: Request): Promise<Response> {
  const expected = process.env["REHEARSAL_RECEIVER_TOKEN"];
  // Fail closed: an unset token locks the endpoint rather than opening it.
  if (expected === undefined || expected.trim() === "") {
    return Response.json({ error: "receiver not configured" }, { status: 503 });
  }

  const header = req.headers.get("authorization") ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (presented === "" || !secretsMatch(presented, expected)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  let config;
  try {
    config = readConfig(process.env);
  } catch (e) {
    console.error(`ledger misconfigured: ${(e as Error).message}`);
    return Response.json({ error: "ledger not available" }, { status: 503 });
  }
  if (config === null) {
    return Response.json({ error: "ledger not configured" }, { status: 503 });
  }

  // An unparseable `since` is rejected rather than ignored. Dropping a filter
  // silently widens the read, which is the fail-open shape.
  const sinceParam = new URL(req.url).searchParams.get("since");
  let sinceIso: string | undefined;
  if (sinceParam !== null) {
    const parsed = Date.parse(sinceParam);
    if (Number.isNaN(parsed)) {
      return Response.json({ error: "since must be an ISO timestamp" }, { status: 400 });
    }
    sinceIso = new Date(parsed).toISOString();
  }

  let rows;
  try {
    rows = await createLedger(config).snapshot(
      sinceIso === undefined ? {} : { sinceIso },
    );
  } catch (e) {
    console.error(`ledger read failed: ${(e as Error).message}`);
    return Response.json({ error: "ledger not available" }, { status: 503 });
  }

  return Response.json(
    {
      instanceId: INSTANCE_ID,
      bootedAtMs: BOOTED_AT_MS,
      nowMs: Date.now(),
      rows,
    },
    { status: 200, headers: { "cache-control": "no-store" } },
  );
}
