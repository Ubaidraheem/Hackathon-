import { calculateScenario } from "@/lib/floodfund/impact";
import { getImpactAssumptions } from "@/lib/floodfund/impact-data";
import { fail, handle, ok } from "@/lib/floodfund/respond";

export const dynamic = "force-dynamic";

export function POST(req: Request) {
  return handle(async () => {
    const body: unknown = await req.json().catch(() => null);
    const result = calculateScenario(body, getImpactAssumptions());
    return result.ok ? ok(result.data) : fail(400, "invalid_impact_scenario", `${result.error.field}. ${result.error.message}`);
  });
}
