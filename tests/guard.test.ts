import { describe, expect, it } from "vitest";
import { config } from "../src/lib/config";
import { buildLiveForecast, type RawForecast } from "../src/lib/floodfund/forecast";
import { combineVerdicts, isFeatureEnvelope, validateCoordinates, validateForecastInput, validateHourlySeries, validateModelFeatures } from "../src/lib/floodfund/guard";
import { buildGuardCaseForecast, GUARD_CASES, GUARD_CONTROL } from "../src/lib/floodfund/guardCases";
import { computeFeatures, FEATURES } from "../src/lib/floodfund/ml-runtime";
import { HOUR_MS } from "../src/lib/floodfund/time";

const NOW = Date.parse("2026-07-01T00:00:00Z");
const zeros = () => Array<number>(24).fill(0);
const ends = Array.from({ length: 24 }, (_, i) => new Date(NOW + (i + 1) * HOUR_MS).toISOString());
const input = (hourlyMm: unknown, extra: Record<string, unknown> = {}) => ({
  ...config.area, hourlyMm, hourlyTimes: ends, ...extra,
});
const codes = (v: ReturnType<typeof validateForecastInput>) => v.reasons.map((r) => r.code);

describe("C04 guard layers", () => {
  it("validates global coordinates before inclusive service bounds", () => {
    expect(codes(validateCoordinates(123.4, -400))).toEqual(["INVALID_LATITUDE", "INVALID_LONGITUDE"]);
    expect(codes(validateCoordinates(22.999, 67))).toEqual(["OUTSIDE_SERVICE_AREA"]);
    expect(validateCoordinates(23, 60).status).toBe("accepted");
    expect(validateCoordinates(37, 78).status).toBe("accepted");
  });

  it("collects count, non-finite, sentinel, negative and timestamp errors", () => {
    const verdict = validateHourlySeries([NaN, -999, -5, null, "0"], ["2026-02-30T01:00:00Z"]);
    expect(codes(verdict)).toEqual(expect.arrayContaining([
      "WRONG_HOURLY_COUNT", "NON_FINITE_VALUE", "SENTINEL_VALUE", "NEGATIVE_RAINFALL", "INVALID_TIMESTAMP",
    ]));
    expect(verdict).toMatchObject({ status: "rejected", confidence: null, canTriggerFunding: false });
    expect(codes(validateHourlySeries(zeros(), [...ends.slice(0, 23), ends[22]]))).toContain("INVALID_TIMESTAMP");
  });

  it("uses strict greater-than checks at the hourly soft and hard caps", () => {
    const withPeak = (peak: number) => [peak, ...zeros().slice(1)];
    expect(validateHourlySeries(withPeak(100)).status).toBe("accepted");
    expect(codes(validateHourlySeries(withPeak(100.01)))).toEqual(["HOURLY_EXCEEDS_SOFT_CAP"]);
    expect(codes(validateHourlySeries(withPeak(150)))).toEqual(["HOURLY_EXCEEDS_SOFT_CAP"]);
    expect(codes(validateHourlySeries(withPeak(150.01)))).toEqual(["HOURLY_EXCEEDS_HARD_CAP"]);
  });

  it("uses strict greater-than checks at the 24-hour soft and hard caps", () => {
    const values = (total: number) => [...Array<number>(10).fill(total / 10), ...zeros().slice(10)];
    expect(validateHourlySeries(values(500)).status).toBe("accepted");
    expect(codes(validateHourlySeries(values(501)))).toEqual(["TOTAL_EXCEEDS_SOFT_CAP"]);
    expect(codes(validateHourlySeries(values(1000)))).toEqual(["TOTAL_EXCEEDS_SOFT_CAP"]);
    expect(codes(validateHourlySeries(values(1001)))).toContain("TOTAL_EXCEEDS_HARD_CAP");
  });

  it("accepts exactly 80 mm, allows the stated tolerance, and rejects a mismatched or missing reported total", () => {
    const rain = [...Array<number>(8).fill(10), ...zeros().slice(8)];
    expect(validateForecastInput(input(rain, { reportedTotalMm: 80 }))).toMatchObject({ status: "accepted", canTriggerFunding: true });
    expect(validateForecastInput(input(rain, { reportedTotalMm: 80.05 })).status).toBe("accepted");
    expect(codes(validateForecastInput(input(rain, { reportedTotalMm: 80.051 })))).toEqual(["TOTAL_MISMATCH"]);
    expect(codes(validateForecastInput(input(rain, { reportedTotalMm: undefined })))).toEqual(["NON_FINITE_VALUE"]);
  });

  it("does not coerce malformed or oversized inputs", () => {
    const huge = Array<unknown>(1_000_000).fill("5");
    for (const sample of ["0", null, undefined, {}, [], [[0]], true, Infinity, huge]) {
      expect(validateForecastInput(sample).status).toBe("rejected");
      expect(validateHourlySeries(sample).status).toBe("rejected");
      expect(validateModelFeatures(sample, null).status).toBe("rejected");
      expect(codes(validateHourlySeries([sample, ...zeros().slice(1)]))).toContain("NON_FINITE_VALUE");
    }
    expect(validateHourlySeries(huge).reasons.length).toBeLessThanOrEqual(25);
  });

  it("combines severity and reduces heuristic confidence as soft breaches accumulate", () => {
    const soft = validateHourlySeries([101, ...zeros().slice(1)]);
    const two = combineVerdicts(validateHourlySeries(zeros()), soft, soft);
    expect(two).toMatchObject({ status: "low_confidence", canTriggerFunding: false, reasons: [...soft.reasons, ...soft.reasons] });
    expect(two.confidence).toBeLessThan(soft.confidence!);
    expect(combineVerdicts(two, validateCoordinates(null, false))).toMatchObject({ status: "rejected", confidence: null, canTriggerFunding: false });
    expect(combineVerdicts().status).toBe("accepted");
  });

  it("flags extrapolation and a missing/malformed training envelope", () => {
    const features = computeFeatures(zeros(), config.area.latitude, config.area.longitude, "2026-07-01");
    const ranges = Object.fromEntries(FEATURES.map((name) => {
      const v = features[name];
      return [name, { min: v, max: v, p1: v, p99: v }];
    }));
    const envelope = { featureOrder: FEATURES, generatedAt: ends[0], features: ranges };
    expect(isFeatureEnvelope(envelope)).toBe(true);
    expect(isFeatureEnvelope({ ...envelope, featureOrder: [...FEATURES].reverse() })).toBe(false);
    expect(isFeatureEnvelope({ ...envelope, features: { ...ranges, latitude: { min: 24, p1: 23, p99: 25, max: 26 } } })).toBe(false);
    expect(validateModelFeatures(features, envelope).status).toBe("accepted");
    const out = validateModelFeatures({ ...features, aifs_wet_hours: 24 }, envelope);
    expect(out).toMatchObject({ status: "low_confidence", canTriggerFunding: false, reasons: [{ field: "aifs_wet_hours", code: "FEATURE_OUT_OF_TRAINING_RANGE" }] });
    expect(validateModelFeatures(features, null)).toMatchObject({ status: "low_confidence", reasons: [{ message: "training envelope unavailable" }] });
    expect(validateModelFeatures({ ...features, latitude: NaN }, envelope).status).toBe("rejected");
  });

  it("rejects malformed provider coordinates and rainfall before returning a numeric forecast", () => {
    const raw: RawForecast = {
      retrievedAtMs: NOW, pinned: true, pinProblem: null, grid: null,
      providerCoordinates: { latitude: "25", longitude: 67 },
      meta: { initMs: NOW - HOUR_MS, availableMs: NOW, stepSeconds: 21600 },
      series: { unit: "mm", timesUnix: ends.map((end) => Date.parse(end) / 1000), values: [900, -999, ...zeros().slice(2)] },
    };
    const forecast = buildLiveForecast(raw, NOW);
    expect(forecast).toMatchObject({ status: "invalid", totalMm: null, hourly: [] });
    expect(codes(forecast.guard!)).toEqual(expect.arrayContaining(["INVALID_LATITUDE", "HOURLY_EXCEEDS_HARD_CAP", "SENTINEL_VALUE"]));
  });
});

describe("deterministic guard demos", () => {
  it.each([...GUARD_CASES, GUARD_CONTROL])("$id returns $expectedStatus", (testCase) => {
    const forecast = buildGuardCaseForecast(testCase, NOW);
    expect(forecast.guard.status).toBe(testCase.expectedStatus);
    expect(codes(forecast.guard)).toEqual(expect.arrayContaining(testCase.expectedReasonCodes));
    expect(forecast.guard.canTriggerFunding).toBe(testCase.expectedStatus === "accepted");
    if (testCase.expectedStatus === "rejected") expect(forecast).toMatchObject({ totalMm: null, hourly: [] });
  });
});
