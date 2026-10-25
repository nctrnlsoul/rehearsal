import plans from "../../../fixtures/plans.json";
import { DEFAULT_CAPS, gateScenario, scenarioDigest } from "../../../lib/engine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// SPIKE ONLY, removed before review: proves the engine bundles and runs here.
export async function GET(): Promise<Response> {
  const out = plans.plans.map((p) => {
    const g = gateScenario(p.scenario, { allowedEventOrigins: [], caps: DEFAULT_CAPS });
    return { plan: p.plan, gated: g.ok, matches: g.ok && scenarioDigest(g.scenario) === p.sha256 };
  });
  return Response.json(out, { headers: { "Cache-Control": "no-store" } });
}
