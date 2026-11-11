import { DRIFT_CASES, driftCaseInfo, runDriftCase } from "@/lib/floodfund/driftCases";
import { saveDriftTest } from "@/lib/floodfund/drift-store";
import { fail, handle, ok, sessionIdFrom, type SessionContext } from "@/lib/floodfund/respond";

export const dynamic = "force-dynamic";

export function POST(req: Request, ctx: SessionContext) {
  return handle(async () => {
    const sessionId = await sessionIdFrom(ctx);
    const body: unknown = await req.json().catch(() => null);
    const caseId = (body as { caseId?: unknown } | null)?.caseId;
    const testCase = DRIFT_CASES.find((item) => item.id === caseId);
    if (!testCase) return fail(400, "invalid_drift_case", "caseId must match an ID from GET /api/v1/drift/cases.");
    return ok(await saveDriftTest(sessionId, driftCaseInfo(testCase), runDriftCase(testCase)));
  });
}
