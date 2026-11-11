import { evaluateForecast } from "@/lib/floodfund/funding";
import { buildGuardCaseForecast, GUARD_CASES, GUARD_CONTROL, guardCaseInfo } from "@/lib/floodfund/guardCases";
import { fail, handle, ok, sessionIdFrom, type SessionContext } from "@/lib/floodfund/respond";
import type { GuardCaseResult } from "@/lib/floodfund/types";

export const dynamic = "force-dynamic";

export function POST(req: Request, ctx: SessionContext) {
  return handle(async () => {
    const sessionId = await sessionIdFrom(ctx);
    const body: unknown = await req.json().catch(() => null);
    const caseId = (body as { caseId?: unknown } | null)?.caseId;
    const testCase = [...GUARD_CASES, GUARD_CONTROL].find((item) => item.id === caseId);
    if (!testCase) return fail(400, "invalid_guard_case", "caseId must match an ID from GET /api/v1/guard/cases.");
    const forecast = buildGuardCaseForecast(testCase, Date.now());
    const result = await evaluateForecast(sessionId, forecast, { trigger: "guard-test", guardCaseId: testCase.id });
    if (!("audit" in result)) throw new Error("Guard test evaluation was not recorded.");
    return ok<GuardCaseResult>({
      testCase: guardCaseInfo(testCase),
      guard: forecast.guard,
      decision: result.decision,
      audit: result.audit,
      budgetBeforePkr: result.budgetBeforePkr,
      budgetAfterPkr: result.budgetAfterPkr,
    });
  });
}
