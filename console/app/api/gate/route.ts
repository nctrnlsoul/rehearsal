import { AttemptLimiter } from "../../../lib/gate";
import { handleGatePost } from "../../../lib/gateRoute";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// One limiter per server instance; see AttemptLimiter for why that is enough in Stage A.
const limiter = new AttemptLimiter();

export async function POST(req: Request): Promise<Response> {
  return handleGatePost(req, { env: process.env, limiter, now: Date.now });
}
