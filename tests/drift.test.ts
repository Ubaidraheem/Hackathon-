import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GET as casesRoute } from "../src/app/api/v1/drift/cases/route";
import { POST as evaluateRoute } from "../src/app/api/v1/drift/evaluate/route";
import { POST as demoRoute } from "../src/app/api/v1/demo/sessions/[sessionId]/drift-test/route";
import { driftDefaults } from "../src/lib/config";
import { evaluateDrift, ksTwoSample, psi } from "../src/lib/floodfund/drift";
import { getDriftStatus, parseDriftReference, rememberDriftComparison } from "../src/lib/floodfund/drift-monitor";
import { DRIFT_CASES, runDriftCase } from "../src/lib/floodfund/driftCases";
import { computeFeatures, FEATURES } from "../src/lib/floodfund/ml-runtime";
import { getComparison } from "../src/lib/floodfund/models";
import { HOUR_MS } from "../src/lib/floodfund/time";

const values = Array.from({ length: 100 }, (_, i) => i);
const json = (data: unknown) => new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } });
const post = (body: unknown) => new Request("http://localhost/api/v1/drift/evaluate", { method: "POST", body: JSON.stringify(body) });

afterEach(() => vi.unstubAllGlobals());

describe("C08 statistics", () => {
  it("uses the same reference bins for identical distributions and produces zero PSI", () => {
    const result = psi(values, [...values].reverse());
    expect(result.value).toBeCloseTo(0, 12);
    expect(result.histogram).toHaveLength(10);
    expect(result.histogram.every((bin) => bin.referenceCount === bin.currentCount)).toBe(true);
  });

  it("smooths empty bins and reports a finite PSI above the alert threshold", () => {
    const result = psi(values, values.map((v) => v + 100));
    expect(result.value).toBeGreaterThan(0.25);
    expect(Number.isFinite(result.value)).toBe(true);
    expect(result.histogram.some((bin) => bin.currentCount === 0)).toBe(true);
    expect(result.histogram.reduce((sum, bin) => sum + bin.currentCount, 0)).toBe(values.length);
  });

  it("handles constant reference and ties in quantile edges", () => {
    expect(psi([2, 2, 2], [3, 3, 3])).toMatchObject({ value: 0, reason: "CONSTANT_REFERENCE" });
    expect(psi([0, 1, 1, 1, 1], [0, 1, 1, 1, 1], 2)).toMatchObject({ value: 0, histogram: [{ upper: 0 }, { upper: null }] });
    expect(psi([], [1])).toMatchObject({ value: null, reason: "INSUFFICIENT_SAMPLE" });
    expect(psi([1], [Infinity])).toMatchObject({ value: null, reason: "INVALID_SAMPLE" });
    expect(psi([1], [2], 1)).toMatchObject({ value: null, reason: "INVALID_BINS" });
  });

  it("matches a hand-computed KS example and returns 1 for the same sample", () => {
    // Disjoint samples give D = 1. With 4 values per side, lambda = sqrt(2).
    // The asymptotic tail is 2 × (exp(-4) - exp(-16) + exp(-36) - …).
    const result = ksTwoSample([0, 1, 2, 3], [4, 5, 6, 7]);
    expect(result.d).toBe(1);
    expect(result.pValue).toBeCloseTo(2 * (Math.exp(-4) - Math.exp(-16)), 12);
    expect(ksTwoSample([1, 2, 2], [2, 1, 2])).toMatchObject({ d: 0, pValue: 1 });
  });

  it("advances tied values on both sides before taking the KS difference", () => {
    // At x = 0 the CDFs are 2/4 and 1/4, at x = 1 both reach 4/4.
    expect(ksTwoSample([0, 0, 1, 1], [0, 1, 1, 1]).d).toBe(0.25);
    expect(ksTwoSample([], [1]).reason).toBe("INSUFFICIENT_SAMPLE");
  });

  it("applies Bonferroni correction to eight features and holds back an undersized window", () => {
    const reference = Object.fromEntries(FEATURES.map((name) => [name, values]));
    const result = evaluateDrift({ reference, current: { ...reference, latitude: values.slice(0, 29) } }, driftDefaults);
    expect(result.ksAlphaPerFeature).toBe(0.01 / 8);
    expect(result.verdict).toBe("insufficient_data");
    expect(result.features.find((f) => f.feature === "latitude")).toMatchObject({ status: "insufficient_data", psi: null, ksD: null, ksPValue: null });
  });

  it("excludes dry-season calendar signals and reports the residual shift separately", () => {
    const seasonal = runDriftCase(DRIFT_CASES[3]);
    expect(seasonal.features.filter((f) => f.status === "seasonal").map((f) => f.feature)).toEqual(["doy_sin", "doy_cos"]);
    expect(seasonal.verdict).toBe("stable");
    const residual = runDriftCase(DRIFT_CASES[2]);
    expect(residual.features.every((f) => f.status === "stable")).toBe(true);
    expect(residual.residuals.meanShiftMm).toBeCloseTo(8);
    expect(residual.residuals.meanShiftCi95Mm?.[0]).toBeGreaterThan(0);
    expect(residual.residuals.status).toBe("drift");
  });

  it.each(DRIFT_CASES)("$id yields $expectedVerdict with the documented reason codes", (testCase) => {
    const result = runDriftCase(testCase);
    expect(result.verdict).toBe(testCase.expectedVerdict);
    expect(result.reasons.map((r) => r.code)).toEqual(expect.arrayContaining(testCase.expectedReasonCodes));
  });
});

describe("C08 endpoints and live inputs", () => {
  it("exposes six synthetic cases and rejects an unknown case ID before writing", async () => {
    expect((await casesRoute().json()).cases).toHaveLength(6);
    const response = await demoRoute(post({ caseId: "unknown" }), { params: Promise.resolve({ sessionId: "a0000000-0000-4000-8000-000000000000" }) });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "invalid_drift_case" } });
  });

  it("validates stateless arrays, length, finite values, and whole-number bins", async () => {
    const bodies = [
      null, { reference: ["2"], current: [1] }, { reference: [null], current: [1] },
      { reference: Array<number>(100_001).fill(1), current: [] },
      { reference: values, current: values, bins: 2.5 }, { reference: [], current: [], bins: 51 },
    ];
    for (const body of bodies) {
      const response = await evaluateRoute(post(body));
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: "invalid_drift_input" } });
    }
    const nonFinite = await evaluateRoute(new Request("http://localhost", { method: "POST", body: '{"reference":[1e999],"current":[1]}' }));
    expect(nonFinite.status).toBe(400);
    const small = await evaluateRoute(post({ reference: [1], current: [1] }));
    expect(await small.json()).toMatchObject({ verdict: "insufficient_data", psi: null, ksD: null });
    const valid = await evaluateRoute(post({ reference: values, current: values, bins: 2 }));
    expect(await valid.json()).toMatchObject({ dataKind: "provided", verdict: "stable", psi: 0, ksD: 0, ksPValue: 1 });
  });

  it("requires a correctly ordered reference artifact and does not fall back to demo data", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ff-no-drift-"));
    expect(await getDriftStatus(Date.now(), dir)).toMatchObject({ status: "unavailable", dataKind: "live", result: null });
    expect(parseDriftReference({ generatedAt: "2026-08-01", featureOrder: [...FEATURES].reverse(), features: {} })).toBeNull();
  });

  it("reuses one archived sample per completed date and leaves residuals unavailable without observations", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ff-drift-reference-"));
    const now = Date.parse("2026-09-20T00:00:00Z");
    const features = Object.fromEntries(FEATURES.map((name) => [name, values]));
    writeFileSync(path.join(dir, "drift_reference.json"), JSON.stringify({ generatedAt: "2026-08-01T00:00:00Z", trainingEnd: "2026-07-31", featureOrder: FEATURES, features }));
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.hostname.includes("single-runs-api")) {
        const run = Date.parse(`${url.searchParams.get("run")}Z`);
        return json({
          latitude: 25, longitude: 67,
          hourly_units: { time: "unixtime", precipitation: "mm" },
          hourly: { time: Array.from({ length: 48 }, (_, i) => (run + i * HOUR_MS) / 1000), precipitation: Array(48).fill(0.5) },
        });
      }
      return json({ properties: { parameter: { IMERG_PRECTOT: {} } } });
    });
    vi.stubGlobal("fetch", fetch);
    expect(await getDriftStatus(now, dir)).toMatchObject({ status: "available", sampleCount: 0, result: { verdict: "insufficient_data" } });
    for (let i = 1; i <= 30; i++) {
      const day = `2026-08-${String(i).padStart(2, "0")}`;
      expect((await getComparison(day, now, dir)).status).toBe("available");
    }
    await getComparison("2026-08-30", now, dir);
    const before = fetch.mock.calls.length;
    const status = await getDriftStatus(now, dir);
    expect(status).toMatchObject({
      status: "available", sampleCount: 30, windowStart: "2026-08-01", windowEnd: "2026-08-30",
      result: { residuals: { status: "unavailable" } },
    });
    expect(status.result?.verdict).not.toBe("insufficient_data");
    expect(fetch).toHaveBeenCalledTimes(before);
  });

  it("uses only post-validation residuals with observed rain and the same team model", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ff-drift-residuals-"));
    const row = computeFeatures(Array<number>(24).fill(0.5), 24.8607, 67.0011, "2026-08-01");
    const features = Object.fromEntries(FEATURES.map((name) => [name, Array<number>(30).fill(row[name])]));
    writeFileSync(path.join(dir, "drift_reference.json"), JSON.stringify({
      generatedAt: "2026-08-31T00:00:00Z", trainingEnd: "2026-07-31", featureOrder: FEATURES, features,
      residuals: { modelId: "random-forest", validationEnd: "2026-08-31", values: Array<number>(30).fill(0) },
    }));
    const forest = { modelId: "random-forest", name: "Forest fixture", rainfallMm: 10, status: "ok", note: null } as const;
    const neural = { ...forest, modelId: "neural-network" } as const;
    rememberDriftComparison("2026-08-31", row, 2, [forest], dir);
    rememberDriftComparison("2026-09-01", row, null, [forest], dir);
    rememberDriftComparison("2026-09-02", row, 2, [neural], dir);
    const now = Date.parse("2026-10-05T00:00:00Z");
    expect((await getDriftStatus(now, dir)).result?.residuals).toMatchObject({ status: "insufficient_data", currentCount: 0 });
    for (let i = 1; i <= 30; i++) rememberDriftComparison(`2026-09-${String(i).padStart(2, "0")}`, row, 2, [forest], dir);
    expect((await getDriftStatus(now, dir)).result).toMatchObject({
      verdict: "retrain_recommended", residuals: { status: "drift", currentCount: 30, modelId: "random-forest", meanShiftMm: expect.closeTo(8) },
    });
  });
});
