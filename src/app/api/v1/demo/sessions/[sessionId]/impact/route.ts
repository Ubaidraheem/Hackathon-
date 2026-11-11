import { getSessionSpend } from "@/lib/floodfund/funding";
import { calculateSessionImpact } from "@/lib/floodfund/impact";
import { getImpactAssumptions } from "@/lib/floodfund/impact-data";
import { handle, ok, sessionIdFrom, type SessionContext } from "@/lib/floodfund/respond";

export const dynamic = "force-dynamic";

export function GET(_req: Request, ctx: SessionContext) {
  return handle(async () => {
    const id = await sessionIdFrom(ctx);
    const { allocationCount, simulatedSpendPkr } = await getSessionSpend(id);
    const result = calculateSessionImpact(allocationCount, simulatedSpendPkr, getImpactAssumptions());
    if (!result.ok) throw new Error(result.error.message);
    return ok(result.data);
  });
}
