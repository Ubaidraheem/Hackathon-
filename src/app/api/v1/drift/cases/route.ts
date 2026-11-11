import { DRIFT_CASES, driftCaseInfo } from "@/lib/floodfund/driftCases";
import { ok } from "@/lib/floodfund/respond";

export const dynamic = "force-dynamic";

export function GET() {
  return ok({ cases: DRIFT_CASES.map(driftCaseInfo) });
}
