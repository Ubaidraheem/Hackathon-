import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { GET as assumptionsRoute } from "../src/app/api/v1/impact/assumptions/route";
import { POST as scenarioRoute } from "../src/app/api/v1/impact/scenario/route";
import { getMeasuredImpact, measuredCounts } from "../src/lib/floodfund/impact-data";
import { calculateImpact, calculateScenario, calculateSessionImpact, IMPACT_ASSUMPTION, IMPACT_DISCLAIMER, IMPACT_PRESETS, makeImpactAssumptions } from "../src/lib/floodfund/impact";
import type { BenchmarkReport } from "../src/lib/floodfund/types";

const values = { portfolioAssetValuePkr: 5_000_000_000, exposedFractionPerEvent: 0.02, damageRatio: 0.15, mitigationEffectiveness: 0.30, falseAlarmExtraCostPkr: 0 };
const assumptions = makeImpactAssumptions(values, 500_000);
const counts = (tp: number, fp: number, fn = 0) => ({ tp, fp, fn, tn: 0 });
const request = (body: unknown) => new Request("http://localhost/api/v1/impact/scenario", { method: "POST", body: JSON.stringify(body) });

describe("C15 financial model", () => {
  it("calculates headline, fully loaded return and missed exposure separately", () => {
    // 5B × .02 × .15 = 15M loss/event. × .30 = 4.5M averted per detection.
    // Headline = 2 × 4.5M − 1 × 0.5M = 8.5M. Fully loaded = 8.5M − 2 × 0.5M.
    expect(calculateImpact(counts(2, 1, 1), assumptions)).toMatchObject({ ok: true, data: {
      lossPerEventPkr: 15_000_000, lossAvertedPerTruePositivePkr: 4_500_000,
      grossLossAvertedPkr: 9_000_000, falseAlarmCostTotalPkr: 500_000, netFinancialGainPkr: 8_500_000,
      fullyLoadedNetPkr: 7_500_000, missedEventExposurePkr: 15_000_000,
      totalSimulatedSpendPkr: 1_500_000, returnOnSpend: 8_500_000 / 1_500_000,
    } });
  });

  it("reports three false alarms as a loss and zero spend as exactly zero net", () => {
    // 0 × 4.5M − 3 × 0.5M = −1.5M. A missed event is separate exposure.
    expect(calculateImpact(counts(0, 3), assumptions)).toMatchObject({ ok: true, data: { netFinancialGainPkr: -1_500_000 } });
    expect(calculateImpact(counts(0, 0, 1), assumptions)).toMatchObject({ ok: true, data: { netFinancialGainPkr: 0, fullyLoadedNetPkr: 0, returnOnSpend: null, missedEventExposurePkr: 15_000_000 } });
  });

  it("crosses break-even at one true detection per nine false alarms", () => {
    // 500,000 / 4,500,000 = 1/9. Precision is 1 / (1 + 9) = 10%.
    expect(calculateImpact(counts(1, 9), assumptions)).toMatchObject({ ok: true, data: {
      netFinancialGainPkr: 0, breakEvenTpToFpRatio: 1 / 9, breakEvenPrecision: 0.1,
    } });
    expect(calculateImpact(counts(1, 8), assumptions)).toMatchObject({ ok: true, data: { netFinancialGainPkr: 500_000 } });
    expect(calculateImpact(counts(1, 10), assumptions)).toMatchObject({ ok: true, data: { netFinancialGainPkr: -500_000 } });
    expect(calculateImpact(counts(1, 0), makeImpactAssumptions({ ...values, mitigationEffectiveness: 0 }, 500_000))).toMatchObject({ ok: true, data: {
      breakEvenTpToFpRatio: null, breakEvenPrecision: null, breakEvenReason: expect.any(String),
    } });
    expect(calculateImpact(counts(1, 0), makeImpactAssumptions({ ...values, mitigationEffectiveness: -0.3 }, 500_000))).toMatchObject({ ok: false, error: { field: "mitigationEffectiveness" } });
  });

  it("rejects invalid or coerced inputs and supports exactly zero overrides", () => {
    for (const tp of [-1, NaN, Infinity, "2", 2.5]) {
      expect(calculateImpact({ ...counts(0, 0), tp: tp as number }, assumptions)).toMatchObject({ ok: false, error: { field: "tp" } });
    }
    const input = { eventCount: 2, recall: 1, falseAlarmCount: 0 };
    for (const overrides of [null, { damageRatio: 1.01 }, { damageRatio: "0.5" }, { extra: 2 }, { portfolioAssetValuePkr: Number.MAX_SAFE_INTEGER }]) {
      expect(calculateScenario({ ...input, overrides }, assumptions).ok).toBe(false);
    }
    expect(calculateScenario({ ...input, overrides: { damageRatio: 0 } }, assumptions)).toMatchObject({ ok: true, data: { impact: { grossLossAvertedPkr: 0 } } });
  });

  it("rounds fractional PKR only at each final output and stays integer-safe", () => {
    // 3 × 0.5 = 1.5 PKR averted per event. Two detections avert 3 PKR, not 4.
    const tiny = makeImpactAssumptions({ ...values, portfolioAssetValuePkr: 3, exposedFractionPerEvent: 1, damageRatio: 1, mitigationEffectiveness: 0.5 }, 0);
    expect(calculateImpact(counts(2, 0), tiny)).toMatchObject({ ok: true, data: { lossAvertedPerTruePositivePkr: 2, grossLossAvertedPkr: 3, netFinancialGainPkr: 3 } });
    const large = makeImpactAssumptions({ ...values, portfolioAssetValuePkr: 100_000_000_000, exposedFractionPerEvent: 1, damageRatio: 1, mitigationEffectiveness: 1 }, 500_000);
    const result = calculateImpact(counts(10_000, 10_000, 10_000), large);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.grossLossAvertedPkr).toBe(1_000_000_000_000_000);
    for (const [key, value] of Object.entries(result.data)) if (key.endsWith("Pkr")) expect(Number.isSafeInteger(value)).toBe(true);
  });

  it("returns a 5 by 5 sensitivity table and a loss under the aggressive illustrative preset", () => {
    const { eventCount, recall, falseAlarmCount } = IMPACT_PRESETS[2];
    const result = calculateScenario({ eventCount, recall, falseAlarmCount }, assumptions);
    expect(result).toMatchObject({ ok: true, data: { impact: { netFinancialGainPkr: -9_500_000, counts: { tp: 9, fp: 100, fn: 1, tn: null } } } });
    if (!result.ok) return;
    expect(result.data.sensitivity).toHaveLength(5);
    expect(result.data.sensitivity.every((row) => row.points.length === 5)).toBe(true);
    expect(result.data.sensitivity[0].points[0].netFinancialGainPkr).toBe(-50_000_000);
    expect(result.data.falseAlarmCurve).toContainEqual({ falseAlarmCount: 100, netFinancialGainPkr: -9_500_000 });
  });

  it("computes a session spend hurdle without assigning detected or missed events", () => {
    expect(calculateSessionImpact(10, 5_000_000, assumptions)).toMatchObject({ ok: true, data: { allocationCount: 10, simulatedSpendPkr: 5_000_000, breakEvenTrueDetections: 2 } });
    expect(calculateSessionImpact(0, 0, assumptions)).toMatchObject({ ok: true, data: { breakEvenTrueDetections: 0 } });
  });
});

describe("C15 saved benchmark", () => {
  it("uses saved counts or derives them only from sufficient statistics", () => {
    const base = { nExamples: 216, referenceAtOrAboveThreshold: 1, predictedAtOrAboveThreshold: 0 };
    expect(measuredCounts(base)).toEqual({ tp: 0, fp: 0, fn: 1, tn: 215 });
    expect(measuredCounts({ ...base, truePositives: 1 })).toBeNull();
    expect(measuredCounts({ ...base, predictedAtOrAboveThreshold: 2, precision: 0.5 })).toEqual({ tp: 1, fp: 1, fn: 0, tn: 214 });
    expect(measuredCounts({ ...base, predictedAtOrAboveThreshold: 2, precision: 0.1 })).toBeNull();
  });

  it("returns unavailable with no numbers when no benchmark artifact exists", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ff-impact-empty-"));
    expect(await getMeasuredImpact(dir)).toMatchObject({ mode: "measured", status: "unavailable", models: [], disclaimer: IMPACT_DISCLAIMER });
  });

  const realDir = path.resolve("backend/artifacts");
  it.skipIf(!existsSync(path.join(realDir, "benchmark.json")))("uses the original benchmark counts, including its observed zero detections", async () => {
    const report = JSON.parse(readFileSync(path.join(realDir, "benchmark.json"), "utf8")) as BenchmarkReport;
    const measured = await getMeasuredImpact(realDir);
    expect(measured.status).toBe("available");
    expect(measured.models).toHaveLength(3);
    for (const { modelId, impact } of measured.models) {
      const metric = report.test.metrics.find((entry) => entry.modelId === modelId)!;
      expect(impact.counts).toMatchObject({ tp: metric.truePositives, fp: metric.falseTriggers, fn: metric.missedEvents });
      expect(impact.counts).toMatchObject({ tp: 0, fp: 0, fn: 1 });
      expect(impact.netFinancialGainPkr).toBe(0);
    }
  });
});

describe("C15 API", () => {
  it("labels assumptions and returns a validated, stateless what-if result", async () => {
    const current = await assumptionsRoute().json();
    expect(Object.values(current.assumptionsUsed).every((a) => (a as { flag: string }).flag === IMPACT_ASSUMPTION)).toBe(true);
    const res = await scenarioRoute(request({ eventCount: 2, recall: 1, falseAlarmCount: 1, overrides: { mitigationEffectiveness: 0 } }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ mode: "what-if", disclaimer: IMPACT_DISCLAIMER, impact: { netFinancialGainPkr: -500_000 }, assumptionsUsed: {
      mitigationEffectiveness: { value: 0, flag: IMPACT_ASSUMPTION },
    } });
    const bad = await scenarioRoute(request({ eventCount: "2", recall: 1, falseAlarmCount: 1 }));
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: { code: "invalid_impact_scenario" } });
  });
});
