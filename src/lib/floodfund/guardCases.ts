import { config, guardDefaults } from "../config";
import { combineVerdicts, validateForecastInput, validateModelFeatures, type FeatureEnvelope, type ForecastGuardInput, type GuardVerdict } from "./guard";
import { computeFeatures, FEATURES } from "./ml-runtime";
import { buildScenarioForecast } from "./scenarios";
import { HOUR_MS, round2 } from "./time";
import type { Forecast, GuardCaseInfo } from "./types";

const DAY = "2026-07-01";
const start = Date.parse(`${DAY}T00:00:00Z`);
const times = Array.from({ length: 24 }, (_, i) => new Date(start + (i + 1) * HOUR_MS).toISOString());
const dry = Array<number>(24).fill(0);

// A deliberately narrow synthetic range for demonstrating extrapolation even
// when the real training artifacts are absent. It is never used by live models.
const demoFeatures = computeFeatures(dry, config.area.latitude, config.area.longitude, DAY);
const demoEnvelope: FeatureEnvelope = {
  featureOrder: FEATURES,
  generatedAt: new Date(start).toISOString(),
  features: Object.fromEntries(FEATURES.map((name) => {
    const value = demoFeatures[name];
    return [name, { min: value, p1: value, p99: value, max: value }];
  })) as FeatureEnvelope["features"],
};

type GuardCase = GuardCaseInfo & {
  input: ForecastGuardInput & { hourlyMm: number[] };
  checkFeatures?: true;
};

function define(
  id: string, title: string, description: string, hourlyMm: number[],
  expectedStatus: GuardCaseInfo["expectedStatus"], expectedReasonCodes: GuardCaseInfo["expectedReasonCodes"],
  overrides?: Partial<GuardCase["input"]>,
): GuardCase {
  return {
    id, title, description, expectedStatus, expectedReasonCodes, label: "DEMO / SYNTHETIC",
    input: { latitude: config.area.latitude, longitude: config.area.longitude, hourlyMm, ...overrides },
  };
}

export const GUARD_CASES: readonly GuardCase[] = [
  define("negative-rainfall", "Negative rainfall", "One hour reports −5 mm.", [-5, ...dry.slice(1)], "rejected", ["NEGATIVE_RAINFALL"]),
  define("impossible-magnitude", "Impossible magnitude", "900 mm in one hour and 60 mm in each of the next two, for a 1,020 mm total.", [900, 60, 60, ...dry.slice(3)], "rejected", ["HOURLY_EXCEEDS_HARD_CAP", "TOTAL_EXCEEDS_HARD_CAP"]),
  define("invalid-coordinates", "Invalid coordinates", "Latitude 123.4° and longitude −400°.", dry, "rejected", ["INVALID_LATITUDE", "INVALID_LONGITUDE"], { latitude: 123.4, longitude: -400 }),
  define("missing-or-corrupt-series", "Missing or corrupt series", "Only 23 values, including NaN and the −999 missing-data sentinel.", [NaN, -999, ...dry.slice(3)], "rejected", ["WRONG_HOURLY_COUNT", "NON_FINITE_VALUE", "SENTINEL_VALUE"]),
  {
    ...define("out-of-training-range-features", "Out-of-training-range features", "24 wet hours at 4 mm each, outside the synthetic training envelope.", Array<number>(24).fill(4), "low_confidence", ["FEATURE_OUT_OF_TRAINING_RANGE"]),
    checkFeatures: true,
  },
];
export const GUARD_CONTROL = define("normal-valid-input", "Normal valid input", "24 valid dry hours, for a 0 mm total.", dry, "accepted", []);

export function guardCaseInfo(testCase: GuardCase): GuardCaseInfo {
  const { id, title, description, label, expectedStatus, expectedReasonCodes } = testCase;
  return { id, title, description, label, expectedStatus, expectedReasonCodes };
}

export function buildGuardCaseForecast(testCase: GuardCase, nowMs: number): Forecast & { guard: GuardVerdict } {
  const input = testCase.input;
  const guard = validateForecastInput({ ...input, ...(input.hourlyMm.length === 24 ? { hourlyTimes: times } : {}) }, guardDefaults);
  const hourly = guard.status === "rejected" ? [] : input.hourlyMm.map((precipitationMm, i) => ({
    intervalStart: new Date(start + i * HOUR_MS).toISOString(),
    intervalEnd: times[i],
    precipitationMm,
  }));
  const { latitude, longitude } = config.area;
  const verdict = testCase.checkFeatures && guard.status !== "rejected"
    ? combineVerdicts(guard, validateModelFeatures(computeFeatures(input.hourlyMm, latitude, longitude, DAY), demoEnvelope, guardDefaults))
    : guard;
  return {
    ...buildScenarioForecast("calm", nowMs),
    scenarioId: null,
    source: "DEMO / SYNTHETIC guard test",
    model: testCase.title,
    modelId: testCase.id,
    modelRunAt: null,
    runAgeHours: null,
    freshnessVerified: false,
    windowStart: new Date(start).toISOString(),
    windowEnd: times[23],
    hourly,
    totalMm: verdict.status === "rejected" ? null : round2(hourly.reduce((sum, hour) => sum + hour.precipitationMm, 0)),
    status: verdict.status === "rejected" ? "invalid" : "fresh",
    statusReason: testCase.description,
    guard: verdict,
  };
}
