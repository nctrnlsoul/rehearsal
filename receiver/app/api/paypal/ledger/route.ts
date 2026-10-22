import { createHash, timingSafeEqual } from "node:crypto";
import { BOOTED_AT_MS, INSTANCE_ID, snapshot } from "../../../../lib/ledger";

/**
 * Read side of the arrival ledger. Requires a shared secret, because the rows
 * describe real payment events and this endpoint is public on the internet.
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

export function GET(req: Request): Response {
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

  return Response.json(
    {
      instanceId: INSTANCE_ID,
      bootedAtMs: BOOTED_AT_MS,
      nowMs: Date.now(),
      rows: snapshot(),
    },
    { status: 200, headers: { "cache-control": "no-store" } },
  );
}
