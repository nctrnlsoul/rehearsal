import { createHash, timingSafeEqual } from "node:crypto";
import { createDb, readConfig } from "../../../../lib/db";
import { DEDUPE_BY_EVENT_ID, summarise } from "../../../../lib/merchant";

/**
 * The store's own state, behind a shared secret. This is what the edge-case
 * finder reads to decide whether the merchant app behaved correctly.
 *
 * `dedupeEnabled` is reported so a demo can show the fix taking effect without
 * anyone having to take a claim on trust.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = ["iad1"];

function secretsMatch(presented: string, expected: string): boolean {
  const a = createHash("sha256").update(presented, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}

export async function GET(req: Request): Promise<Response> {
  const expected = process.env["REHEARSAL_STORE_TOKEN"];
  // Fail closed: an unset token locks the endpoint rather than opening it.
  if (expected === undefined || expected.trim() === "") {
    return Response.json({ error: "store not configured" }, { status: 503 });
  }

  const header = req.headers.get("authorization") ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (presented === "" || !secretsMatch(presented, expected)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  // Validated at the trust boundary, before storage state can mask it. An
  // unparseable filter is rejected rather than ignored, because dropping it
  // silently widens the read.
  const sinceParam = new URL(req.url).searchParams.get("since");
  let sinceIso: string | undefined;
  if (sinceParam !== null) {
    const parsed = Date.parse(sinceParam);
    if (Number.isNaN(parsed)) {
      return Response.json({ error: "since must be an ISO timestamp" }, { status: 400 });
    }
    sinceIso = new Date(parsed).toISOString();
  }

  let config;
  try {
    config = readConfig(process.env);
  } catch (e) {
    console.error(`store db misconfigured: ${(e as Error).message}`);
    return Response.json({ error: "store not available" }, { status: 503 });
  }
  if (config === null) {
    return Response.json({ error: "store db not configured" }, { status: 503 });
  }

  try {
    const rows = await createDb(config).rows(sinceIso === undefined ? {} : { sinceIso });
    return Response.json(
      { ...summarise(rows), dedupeEnabled: DEDUPE_BY_EVENT_ID },
      { status: 200, headers: { "cache-control": "no-store" } },
    );
  } catch (e) {
    console.error(`store read failed: ${(e as Error).message}`);
    return Response.json({ error: "store not available" }, { status: 503 });
  }
}
