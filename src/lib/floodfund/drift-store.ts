import { eq } from "drizzle-orm";
import { db } from "../../db";
import { ensureSchema } from "../../db/ensure";
import { auditRecords, driftChecks, sessions } from "../../db/schema";
import type { DriftResult } from "./drift";
import type { DriftCaseInfo } from "./driftCases";
import { NotFoundError } from "./funding";
import type { AuditRecord } from "./types";

export type DriftCaseResult = DriftResult & {
  dataKind: "demo";
  testCase: DriftCaseInfo;
  driftCheckId: number;
  audit: AuditRecord;
  budgetBeforePkr: number;
  budgetAfterPkr: number;
};

export async function saveDriftTest(sessionId: string, testCase: DriftCaseInfo, result: DriftResult): Promise<DriftCaseResult> {
  await ensureSchema();
  return db.transaction(async (tx) => {
    const [session] = await tx.select({ budget: sessions.budgetPkr }).from(sessions).where(eq(sessions.id, sessionId)).for("update");
    if (!session) throw new NotFoundError("Session not found.");
    const createdAt = new Date();
    const [check] = await tx.insert(driftChecks).values({
      sessionId, caseId: testCase.id, verdict: result.verdict,
      perFeatureResults: result.features, reasons: result.reasons, createdAt,
    }).returning({ id: driftChecks.id });
    const reasonCodes = [...new Set(result.reasons.map((r) => r.code))];
    const details = {
      dataKind: "demo", caseId: testCase.id, driftCheckId: check.id, verdict: result.verdict, reasonCodes,
      reasons: result.reasons, residuals: result.residuals,
      budgetBeforePkr: session.budget, budgetAfterPkr: session.budget, simulated: true,
    };
    const type = "drift_test";
    const message = `DEMO / SYNTHETIC drift test (${testCase.title}) reported ${result.verdict}.${reasonCodes.length ? ` ${reasonCodes.join(", ")}.` : ""} Budget unchanged.`;
    const [entry] = await tx.insert(auditRecords).values({ sessionId, type, message, details, createdAt }).returning({ id: auditRecords.id });
    return {
      ...result, dataKind: "demo", testCase, driftCheckId: check.id,
      audit: { id: entry.id, type, message, details, createdAt: createdAt.toISOString() },
      budgetBeforePkr: session.budget, budgetAfterPkr: session.budget,
    };
  });
}
