import { dbFromEnv } from "../../../lib/db";
import { DEFAULT_PLANNER_MODEL, anthropicGenerator } from "../../../lib/engine";
import { handlePlanPost } from "../../../lib/live";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// One model call, bounded at 60 s by the planner itself, plus the database calls.
export const maxDuration = 90;

export async function POST(req: Request): Promise<Response> {
  const key = process.env["ANTHROPIC_API_KEY"];
  const model = process.env["REHEARSAL_PLANNER_MODEL"]?.trim() || DEFAULT_PLANNER_MODEL;
  const generate = key !== undefined && key.trim() !== "" ? anthropicGenerator({ apiKey: key.trim(), model }) : null;
  return handlePlanPost(req, { env: process.env, db: dbFromEnv(process.env), now: Date.now, generate });
}
