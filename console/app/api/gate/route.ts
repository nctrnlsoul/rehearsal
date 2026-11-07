import { dbFromEnv } from "../../../lib/db";
import { dbAttemptStore, sessionSecret } from "../../../lib/gate";
import { handleGatePost } from "../../../lib/gateRoute";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  const secret = sessionSecret(process.env);
  const db = dbFromEnv(process.env);
  // Either missing leaves the store null, and the gate stays shut.
  const attempts = db === null || secret === null ? null : dbAttemptStore(db, secret);
  return handleGatePost(req, { env: process.env, attempts, now: Date.now });
}
