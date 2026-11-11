import { GUARD_CASES, GUARD_CONTROL, guardCaseInfo } from "@/lib/floodfund/guardCases";
import { ok } from "@/lib/floodfund/respond";

export const dynamic = "force-dynamic";

export function GET() {
  return ok({ cases: [...GUARD_CASES, GUARD_CONTROL].map(guardCaseInfo) });
}
