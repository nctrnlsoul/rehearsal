import { dbFromEnv } from "../../../lib/db";
import { handleBankGet } from "../../../lib/live";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  return handleBankGet(req, { env: process.env, db: dbFromEnv(process.env), now: Date.now });
}
