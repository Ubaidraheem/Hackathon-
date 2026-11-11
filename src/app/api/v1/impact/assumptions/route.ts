import { impactAssumptionsResponse } from "@/lib/floodfund/impact";
import { getImpactAssumptions } from "@/lib/floodfund/impact-data";
import { ok } from "@/lib/floodfund/respond";

export const dynamic = "force-dynamic";

export function GET() {
  return ok(impactAssumptionsResponse(getImpactAssumptions()));
}
