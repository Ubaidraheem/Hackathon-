import { driftDefaults } from "../config";
import { evaluateDrift, type DriftReasonCode, type DriftVerdict } from "./drift";
import { FEATURES, type FeatureName } from "./ml-runtime";
import { HOUR_MS } from "./time";

const dates = (start: string, count: number) => Array.from({ length: count }, (_, i) =>
  new Date(Date.parse(start) + i * 24 * HOUR_MS).toISOString().slice(0, 10));
const monsoon = dates("2026-05-01", 100);
const drySeason = dates("2026-10-01", 100);
const index = Array.from({ length: 100 }, (_, i) => i);
const angle = (date: string) => 2 * Math.PI * ((Date.parse(date) - Date.parse(`${date.slice(0, 4)}-01-01`)) / (24 * HOUR_MS) + 1) / 365.25;
const calendar = (days: string[]) => ({ doy_sin: days.map((d) => Math.sin(angle(d))), doy_cos: days.map((d) => Math.cos(angle(d))) });
type Features = Record<FeatureName, readonly number[]>;
const reference: Features = {
  aifs_total_24h_mm: index.map((i) => i * 0.8),
  aifs_max_hourly_mm: index.map((i) => i * 0.25),
  aifs_wet_hours: index.map((i) => Math.floor(i / 5)),
  aifs_max_6h_mm: index.map((i) => i * 0.4),
  latitude: index.map((i) => 24 + i / 100),
  longitude: index.map((i) => 67 + i / 100),
  ...calendar(monsoon),
};
const small = Object.fromEntries(FEATURES.map((name) => [name, reference[name].slice(0, 10)]));
const residualReference = index.map((i) => (i % 10 - 4.5) * 0.2);
const warningFeature = reference.aifs_total_24h_mm.map((v, i) => i >= 10 && i < 70 && i % 10 >= 8 ? 0 : v);

export interface DriftCaseInfo {
  id: string;
  title: string;
  description: string;
  label: "DEMO / SYNTHETIC";
  expectedVerdict: DriftVerdict;
  expectedReasonCodes: DriftReasonCode[];
}
type Case = Omit<DriftCaseInfo, "label"> & {
  current: Parameters<typeof evaluateDrift>[0]["current"];
  currentDates?: string[];
  residuals?: Parameters<typeof evaluateDrift>[0]["residuals"];
};

export const DRIFT_CASES: readonly Case[] = [
  {
    id: "stable-same-distribution", title: "Stable distribution", description: "100 matching values per feature in each window.",
    expectedVerdict: "stable", expectedReasonCodes: [], current: reference,
  },
  {
    id: "covariate-shift-heavier-rain", title: "Heavier-rain inputs", description: "Four AIFS rainfall features shift while geography and calendar stay fixed.",
    expectedVerdict: "retrain_recommended", expectedReasonCodes: ["PSI_ABOVE_DRIFT", "KS_SIGNIFICANT"],
    current: {
      ...reference,
      aifs_total_24h_mm: reference.aifs_total_24h_mm.map((v) => v + 80),
      aifs_max_hourly_mm: reference.aifs_max_hourly_mm.map((v) => v + 25),
      aifs_wet_hours: index.map((i) => 18 + i % 7),
      aifs_max_6h_mm: reference.aifs_max_6h_mm.map((v) => v + 40),
    },
  },
  {
    id: "concept-drift-residual-bias", title: "Residual bias", description: "Input distributions match. Synthetic matched signed residuals shift by +8 mm.",
    expectedVerdict: "retrain_recommended", expectedReasonCodes: ["RESIDUAL_SHIFT"], current: reference,
    residuals: { reference: residualReference, current: residualReference.map((v) => v + 8), modelId: "synthetic-demo" },
  },
  {
    id: "seasonal-shift-dry-season", title: "Dry-season calendar shift", description: "Only day-of-year features move to October–January.",
    expectedVerdict: "stable", expectedReasonCodes: ["SEASONAL_SHIFT_EXCLUDED"],
    current: { ...reference, ...calendar(drySeason) }, currentDates: drySeason,
  },
  {
    id: "insufficient-data", title: "Too few samples", description: "The current window has 10 samples per feature.",
    expectedVerdict: "insufficient_data", expectedReasonCodes: ["INSUFFICIENT_SAMPLE"], current: small,
  },
  {
    id: "single-feature-warning", title: "Single-feature warning", description: "12 of 100 daily totals move into the first reference bin.",
    expectedVerdict: "warning", expectedReasonCodes: ["PSI_IN_WARNING_BAND"],
    current: { ...reference, aifs_total_24h_mm: warningFeature },
  },
];

export function driftCaseInfo({ id, title, description, expectedVerdict, expectedReasonCodes }: Case): DriftCaseInfo {
  return { id, title, description, expectedVerdict, expectedReasonCodes, label: "DEMO / SYNTHETIC" };
}

export function runDriftCase(testCase: Case) {
  // Keep the judged cases reproducible even when live monitoring is reconfigured.
  return evaluateDrift({ reference, current: testCase.current, currentDates: testCase.currentDates ?? monsoon, residuals: testCase.residuals }, driftDefaults);
}
