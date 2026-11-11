import { config, type driftDefaults } from "../config";
import { utcDayStart } from "./time";

export type DriftVerdict = "stable" | "warning" | "retrain_recommended" | "insufficient_data";
export type DriftFeatureStatus = "stable" | "warning" | "drift" | "seasonal" | "insufficient_data";
export type DriftReasonCode =
  | "PSI_ABOVE_DRIFT" | "PSI_IN_WARNING_BAND" | "KS_SIGNIFICANT"
  | "INSUFFICIENT_SAMPLE" | "INVALID_SAMPLE" | "INVALID_BINS" | "CONSTANT_REFERENCE"
  | "SEASONAL_SHIFT_EXCLUDED" | "RESIDUAL_SHIFT" | "OBSERVATIONS_REQUIRED";

export interface DriftReason { code: DriftReasonCode; field: string; message: string }
export interface DriftBin { lower: number | null; upper: number | null; referenceCount: number; currentCount: number }
export interface DriftFeatureResult {
  feature: string;
  status: DriftFeatureStatus;
  referenceCount: number;
  currentCount: number;
  psi: number | null;
  ksD: number | null;
  ksPValue: number | null;
  ksSignificant: boolean;
  histogram: DriftBin[];
}
export interface ResidualDriftResult {
  status: "unavailable" | "insufficient_data" | "stable" | "drift";
  modelId?: string;
  referenceCount: number;
  currentCount: number;
  ksD: number | null;
  ksPValue: number | null;
  meanShiftMm: number | null;
  meanShiftCi95Mm: [number, number] | null;
}
export interface DriftResult {
  verdict: DriftVerdict;
  features: DriftFeatureResult[];
  residuals: ResidualDriftResult;
  reasons: DriftReason[];
  ksAlphaPerFeature: number;
  minSamples: number;
}

type DriftOptions = Omit<typeof driftDefaults, "enabled">;
type Columns = Readonly<Record<string, readonly number[]>>;
interface DriftInput {
  reference: Columns;
  current: Columns;
  currentDates?: readonly string[];
  residuals?: { reference: readonly number[]; current: readonly number[]; modelId?: string };
}

export const MAX_DRIFT_VALUES = 100_000;
export const OBSERVATION_LAG_NOTE = "Residual checks need a NASA POWER IMERG value for the same UTC day. Recent values may be missing or based on the provisional Late Run.";
const EPSILON = 1e-4;

export function isDriftSample(value: unknown): value is number[] {
  if (!Array.isArray(value) || value.length > MAX_DRIFT_VALUES) return false;
  // Index access also detects sparse arrays, which Array.every would skip.
  for (let i = 0; i < value.length; i++) if (!Number.isFinite(value[i])) return false;
  return true;
}

function histogram(reference: readonly number[], current: readonly number[], edges: number[]): DriftBin[] {
  const rows = Array.from({ length: edges.length + 1 }, (_, i) => ({
    lower: edges[i - 1] ?? null, upper: edges[i] ?? null, referenceCount: 0, currentCount: 0,
  }));
  function count(sample: readonly number[], key: "referenceCount" | "currentCount") {
    for (const value of sample) {
      let low = 0;
      let high = edges.length;
      while (low < high) {
        const mid = (low + high) >>> 1;
        if (value <= edges[mid]) high = mid;
        else low = mid + 1;
      }
      rows[low][key]++;
    }
  }
  count(reference, "referenceCount");
  count(current, "currentCount");
  return rows;
}

export function psi(reference: readonly number[], current: readonly number[], bins = 10): {
  value: number | null; reason: DriftReasonCode | null; histogram: DriftBin[];
} {
  if (!Number.isInteger(bins) || bins < 2 || bins > 50) return { value: null, reason: "INVALID_BINS", histogram: [] };
  if (!isDriftSample(reference) || !isDriftSample(current)) return { value: null, reason: "INVALID_SAMPLE", histogram: [] };
  if (reference.length === 0 || current.length === 0) return { value: null, reason: "INSUFFICIENT_SAMPLE", histogram: [] };
  const sorted = [...reference].sort((a, b) => a - b);
  const max = sorted[sorted.length - 1];
  if (sorted[0] === max) return { value: 0, reason: "CONSTANT_REFERENCE", histogram: histogram(reference, current, [max]) };
  const edges = [...new Set(Array.from({ length: bins - 1 }, (_, i) => sorted[Math.ceil((i + 1) * sorted.length / bins) - 1]))]
    .filter((edge) => edge < max);
  // A dominant tie at the maximum can collapse every interior quantile.
  if (!edges.length) edges.push(sorted[0]);
  const rows = histogram(reference, current, edges);
  let value = 0;
  for (const row of rows) {
    const r = (row.referenceCount + EPSILON) / (reference.length + rows.length * EPSILON);
    const c = (row.currentCount + EPSILON) / (current.length + rows.length * EPSILON);
    value += (c - r) * Math.log(c / r);
  }
  return { value, reason: null, histogram: rows };
}

/** Asymptotic two-sided Kolmogorov survival function, with the small-x CDF expansion. */
function ksTail(x: number): number {
  if (x === 0) return 1;
  let sum = 0;
  if (x < 1) {
    for (let k = 1; k <= 100; k++) {
      const term = Math.exp(-((2 * k - 1) ** 2) * Math.PI ** 2 / (8 * x ** 2));
      sum += term;
      if (term < 1e-14) break;
    }
    return Math.max(0, Math.min(1, 1 - Math.sqrt(2 * Math.PI) * sum / x));
  }
  for (let k = 1; k <= 100; k++) {
    const term = Math.exp(-2 * k * k * x * x);
    sum += k % 2 === 1 ? term : -term;
    if (term < 1e-14) break;
  }
  return Math.max(0, Math.min(1, 2 * sum));
}

export function ksTwoSample(a: readonly number[], b: readonly number[]): {
  d: number | null; pValue: number | null; reason: DriftReasonCode | null;
} {
  if (!isDriftSample(a) || !isDriftSample(b)) return { d: null, pValue: null, reason: "INVALID_SAMPLE" };
  if (!a.length || !b.length) return { d: null, pValue: null, reason: "INSUFFICIENT_SAMPLE" };
  const x = [...a].sort((u, v) => u - v);
  const y = [...b].sort((u, v) => u - v);
  let i = 0;
  let j = 0;
  let d = 0;
  while (i < x.length || j < y.length) {
    const boundary = Math.min(x[i] ?? Infinity, y[j] ?? Infinity);
    // Advance both CDFs through the entire tie before comparing them.
    while (i < x.length && x[i] <= boundary) i++;
    while (j < y.length && y[j] <= boundary) j++;
    d = Math.max(d, Math.abs(i / x.length - j / y.length));
  }
  return { d, pValue: ksTail(d * Math.sqrt(x.length * y.length / (x.length + y.length))), reason: null };
}

function residualDrift(samples: DriftInput["residuals"], options: DriftOptions, reasons: DriftReason[]): ResidualDriftResult {
  const base = {
    modelId: samples?.modelId,
    referenceCount: samples?.reference.length ?? 0, currentCount: samples?.current.length ?? 0,
    ksD: null, ksPValue: null, meanShiftMm: null, meanShiftCi95Mm: null,
  };
  if (!samples) {
    reasons.push({ code: "OBSERVATIONS_REQUIRED", field: "residuals", message: OBSERVATION_LAG_NOTE });
    return { ...base, status: "unavailable" };
  }
  if (!isDriftSample(samples.reference) || !isDriftSample(samples.current) ||
      samples.reference.length < options.minSamples || samples.current.length < options.minSamples) {
    reasons.push({ code: "INSUFFICIENT_SAMPLE", field: "residuals", message: `Residual checks require at least ${options.minSamples} finite, observation-matched samples per window. ${OBSERVATION_LAG_NOTE}` });
    return { ...base, status: "insufficient_data" };
  }
  const stats = (values: readonly number[]) => {
    const mean = values.reduce((sum, value) => sum + value / values.length, 0);
    const varianceOfMean = values.reduce((sum, value) => sum + (value - mean) ** 2 / (values.length * (values.length - 1)), 0);
    return { mean, varianceOfMean };
  };
  const r = stats(samples.reference);
  const c = stats(samples.current);
  const meanShiftMm = c.mean - r.mean;
  const margin = 1.96 * Math.sqrt(r.varianceOfMean + c.varianceOfMean);
  const ci: [number, number] = [meanShiftMm - margin, meanShiftMm + margin];
  if (!ci.every(Number.isFinite)) {
    reasons.push({ code: "INVALID_SAMPLE", field: "residuals", message: "Residual magnitudes exceed the finite range of the mean-shift calculation." });
    return { ...base, status: "insufficient_data" };
  }
  const ks = ksTwoSample(samples.reference, samples.current);
  const drift = ks.pValue !== null && ks.pValue < options.ksAlpha && (ci[0] > 0 || ci[1] < 0);
  if (drift) reasons.push({ code: "RESIDUAL_SHIFT", field: "residuals", message: "Signed errors shifted: KS is significant and the approximate 95% mean-shift interval excludes zero." });
  return { ...base, status: drift ? "drift" : "stable", ksD: ks.d, ksPValue: ks.pValue, meanShiftMm, meanShiftCi95Mm: ci };
}

export function evaluateDrift({ reference, current, residuals, currentDates }: DriftInput, options: DriftOptions = config.drift): DriftResult {
  const names = [...new Set([...Object.keys(reference), ...Object.keys(current)])];
  const ksAlphaPerFeature = options.ksAlpha / Math.max(1, names.length);
  const reasons: DriftReason[] = [];
  const offSeason = currentDates?.some((date) => {
    if (utcDayStart(date) === null) return false;
    const month = Number(date.slice(5, 7));
    return month < 4 || month > 9;
  }) ?? false;
  let severe = 0;
  let warnings = false;
  const features = names.map((feature): DriftFeatureResult => {
    const r = reference[feature] ?? [];
    const c = current[feature] ?? [];
    const base = { feature, referenceCount: r.length, currentCount: c.length };
    if (!isDriftSample(r) || !isDriftSample(c) || r.length < options.minSamples || c.length < options.minSamples) {
      reasons.push({ code: "INSUFFICIENT_SAMPLE", field: feature, message: `At least ${options.minSamples} finite samples are required in both windows.` });
      return { ...base, status: "insufficient_data", psi: null, ksD: null, ksPValue: null, ksSignificant: false, histogram: [] };
    }
    const index = psi(r, c, options.bins);
    const ks = ksTwoSample(r, c);
    if (index.reason === "CONSTANT_REFERENCE") reasons.push({ code: index.reason, field: feature, message: "Reference has no spread. PSI is reported as zero; use KS and the sample counts for context." });
    const ksSignificant = ks.pValue !== null && ks.pValue < ksAlphaPerFeature;
    const high = index.value !== null && index.value > options.psiAlert;
    const moderate = !high && index.value !== null && index.value >= options.psiWarn;
    if (high) reasons.push({ code: "PSI_ABOVE_DRIFT", field: feature, message: `PSI exceeds ${options.psiAlert}.` });
    if (moderate) reasons.push({ code: "PSI_IN_WARNING_BAND", field: feature, message: `PSI is in the warning band (${options.psiWarn}–${options.psiAlert}).` });
    if (ksSignificant) reasons.push({ code: "KS_SIGNIFICANT", field: feature, message: "The asymptotic KS p-value is below the Bonferroni-adjusted feature threshold." });
    const seasonal = (high || moderate || ksSignificant) && offSeason && (feature === "doy_sin" || feature === "doy_cos");
    if (seasonal) reasons.push({ code: "SEASONAL_SHIFT_EXCLUDED", field: feature, message: "Calendar features shifted in a window with dates outside April–September. This feature is excluded from the overall warning and retraining counts." });
    else {
      if (high && ksSignificant) severe++;
      warnings ||= moderate || ksSignificant;
    }
    const status = seasonal ? "seasonal" : high ? "drift" : moderate || ksSignificant ? "warning" : "stable";
    return { ...base, status, psi: index.value, ksD: ks.d, ksPValue: ks.pValue, ksSignificant, histogram: index.histogram };
  });
  if (!features.length) reasons.push({ code: "INSUFFICIENT_SAMPLE", field: "features", message: "No feature samples were provided." });
  const residual = residualDrift(residuals, options, reasons);
  const verdict = !features.length || features.some((f) => f.status === "insufficient_data") ? "insufficient_data"
    : residual.status === "drift" || severe >= options.retrainFeatureCount ? "retrain_recommended"
      : warnings ? "warning" : "stable";
  return { verdict, features, residuals: residual, reasons, ksAlphaPerFeature, minSamples: options.minSamples };
}
