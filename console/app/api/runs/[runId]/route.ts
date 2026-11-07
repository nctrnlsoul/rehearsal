import { dbFromEnv } from "../../../../lib/db";
import { handleRunGet } from "../../../../lib/live";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ runId: string }> }): Promise<Response> {
  const { runId } = await ctx.params;
  return handleRunGet(req, runId, { env: process.env, db: dbFromEnv(process.env), now: Date.now });
}
