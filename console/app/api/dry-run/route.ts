import { dbFromEnv } from "../../../lib/db";
import { handleDryRunPost } from "../../../lib/live";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  return handleDryRunPost(req, { env: process.env, db: dbFromEnv(process.env), now: Date.now });
}
