import { config, guardDefaults } from "../config";
import { FEATURES } from "./ml-runtime";
import { HOUR_MS, utcDayStart } from "./time";

export type GuardStatus = "accepted" | "low_confidence" | "rejected";
export type GuardReasonCode =
  | "INVALID_LATITUDE" | "INVALID_LONGITUDE" | "OUTSIDE_SERVICE_AREA"
  | "WRONG_HOURLY_COUNT" | "NON_FINITE_VALUE" | "SENTINEL_VALUE"
  | "NEGATIVE_RAINFALL" | "HOURLY_EXCEEDS_HARD_CAP" | "TOTAL_EXCEEDS_HARD_CAP"
  | "TOTAL_MISMATCH" | "INVALID_TIMESTAMP"
  | "HOURLY_EXCEEDS_SOFT_CAP" | "TOTAL_EXCEEDS_SOFT_CAP"
  | "FEATURE_OUT_OF_TRAINING_RANGE";

export interface GuardReason {
  code: GuardReasonCode;
  field: string;
  value: unknown;
  limit?: unknown;
  message: string;
  severity: "reject" | "low_confidence";
}

export interface GuardVerdict {
  status: GuardStatus;
  reasons: GuardReason[];
  confidence: number | null;
  checkedAt: string;
  canTriggerFunding: boolean;
}

type Limits = typeof guardDefaults;
export interface ForecastGuardInput {
  latitude: unknown;
  longitude: unknown;
  hourlyMm: unknown;
  hourlyTimes?: unknown;
  reportedTotalMm?: unknown;
}

type FeatureRange = { min: number; max: number; p1: number; p99: number };
export interface FeatureEnvelope {
  featureOrder: readonly string[];
  generatedAt: string;
  features: Record<(typeof FEATURES)[number], FeatureRange>;
}

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

// Keep diagnostics bounded and JSON-safe, including values that JSON cannot represent.
function describe(value: unknown): unknown {
  if (value === null || typeof value === "boolean" || finite(value)) return value;
  if (typeof value === "string") return value.slice(0, 160);
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) return `Array(${value.length})`;
  return typeof value;
}

export function guardReason(code: GuardReasonCode, field: string, value: unknown, message: string, limit?: unknown, severity: GuardReason["severity"] = "reject"): GuardReason {
  return { code, field, value: describe(value), message, limit, severity };
}

export function guardVerdict(reasons: GuardReason[], checkedAt = new Date().toISOString()): GuardVerdict {
  const rejected = reasons.some((reason) => reason.severity === "reject");
  const status = rejected ? "rejected" : reasons.length ? "low_confidence" : "accepted";
  // Heuristic score: each soft breach increases the denominator by one. This is not a probability.
  return { status, reasons, checkedAt, confidence: rejected ? null : 1 / (1 + reasons.length), canTriggerFunding: status === "accepted" };
}

export function combineVerdicts(...verdicts: GuardVerdict[]): GuardVerdict {
  const checkedAt = verdicts.map((verdict) => verdict.checkedAt).sort().at(-1);
  return guardVerdict(verdicts.flatMap((verdict) => verdict.reasons), checkedAt);
}

export function validateCoordinates(lat: unknown, lon: unknown, limits: Limits = config.guard): GuardVerdict {
  const reasons: GuardReason[] = [];
  if (!finite(lat) || lat < -90 || lat > 90) {
    reasons.push(guardReason("INVALID_LATITUDE", "latitude", lat, "Latitude must be a finite number between −90 and 90.", [-90, 90]));
  }
  if (!finite(lon) || lon < -180 || lon > 180) {
    reasons.push(guardReason("INVALID_LONGITUDE", "longitude", lon, "Longitude must be a finite number between −180 and 180.", [-180, 180]));
  }
  const [south, north, west, east] = limits.coordBounds;
  if (limits.enabled && reasons.length === 0 && finite(lat) && finite(lon) && (lat < south || lat > north || lon < west || lon > east)) {
    reasons.push({ ...guardReason("OUTSIDE_SERVICE_AREA", "coordinates", null, "The point is outside the configured service bounds.", limits.coordBounds), value: [lat, lon] });
  }
  return guardVerdict(reasons);
}

function rainfallIssue(value: unknown, field: string): GuardReason | undefined {
  if (!finite(value)) return guardReason("NON_FINITE_VALUE", field, value, "Rainfall must be a finite number. Missing data is not treated as zero.");
  if (value === -999) return guardReason("SENTINEL_VALUE", field, value, "The −999 missing-data sentinel is not rainfall.");
  if (value < 0) return guardReason("NEGATIVE_RAINFALL", field, value, "Rainfall cannot be negative.");
}

function timestampMs(value: unknown): number {
  if (finite(value) && Number.isSafeInteger(value)) return value * 1000;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:00:00(?:\.000)?Z$/.test(value) || utcDayStart(value.slice(0, 10)) === null || Number(value.slice(11, 13)) > 23) return NaN;
  return Date.parse(value);
}

function inspectHourly(values: unknown, timestamps: unknown, limits: Limits): { reasons: GuardReason[]; sum: number | null } {
  const reasons: GuardReason[] = [];
  const validCount = Array.isArray(values) && values.length === 24;
  if (!validCount) reasons.push(guardReason("WRONG_HOURLY_COUNT", "hourlyMm", Array.isArray(values) ? values.length : values, "Exactly 24 hourly rainfall values are required.", 24));
  let sum = 0;
  let validValues = validCount;
  // Oversized arrays are already rejected; inspect at most the 24 expected slots.
  if (Array.isArray(values)) for (let i = 0; i < Math.min(values.length, 24); i++) {
    const v: unknown = values[i];
    const field = `hourlyMm[${i}]`;
    const issue = rainfallIssue(v, field);
    if (issue) {
      reasons.push(issue);
      validValues = false;
    } else if (finite(v)) {
      sum += v;
      if (limits.enabled && v > limits.maxHourlyMm) {
        reasons.push(guardReason("HOURLY_EXCEEDS_HARD_CAP", field, v, "Hourly rainfall exceeds the engineering cap.", limits.maxHourlyMm));
      } else if (limits.enabled && v > limits.softHourlyMm) {
        reasons.push(guardReason("HOURLY_EXCEEDS_SOFT_CAP", field, v, "Hourly rainfall is unusually high for this application.", limits.softHourlyMm, "low_confidence"));
      }
    }
  }
  if (timestamps !== undefined) {
    if (!Array.isArray(timestamps) || timestamps.length !== 24) {
      reasons.push(guardReason("INVALID_TIMESTAMP", "hourlyTimes", timestamps, "Exactly 24 hourly timestamps are required.", 24));
    }
    if (Array.isArray(timestamps)) for (let i = 0; i < Math.min(timestamps.length, 24); i++) {
      const t = timestampMs(timestamps[i]);
      const previous = i === 0 ? NaN : timestampMs(timestamps[i - 1]);
      if (!Number.isFinite(t) || Math.abs(t) > 8.64e15 || t % HOUR_MS !== 0 || (Number.isFinite(previous) && t - previous !== HOUR_MS)) {
        reasons.push(guardReason("INVALID_TIMESTAMP", `hourlyTimes[${i}]`, timestamps[i], "Timestamps must be consecutive UTC hour boundaries."));
      }
    }
  }
  if (validValues && !finite(sum)) {
    reasons.push(guardReason("NON_FINITE_VALUE", "totalMm", sum, "The hourly values overflowed the 24-hour total."));
    validValues = false;
  }
  if (validValues && limits.enabled && sum > limits.max24hMm) {
    reasons.push(guardReason("TOTAL_EXCEEDS_HARD_CAP", "totalMm", sum, "24-hour rainfall exceeds the engineering cap.", limits.max24hMm));
  } else if (validValues && limits.enabled && sum > limits.soft24hMm) {
    reasons.push(guardReason("TOTAL_EXCEEDS_SOFT_CAP", "totalMm", sum, "24-hour rainfall is unusually high for this application.", limits.soft24hMm, "low_confidence"));
  }
  return { reasons, sum: validValues ? sum : null };
}

export function validateHourlySeries(values: unknown, timestamps?: unknown): GuardVerdict {
  return guardVerdict(inspectHourly(values, timestamps, config.guard).reasons);
}

export function validateForecastInput(input: unknown, limits: Limits = config.guard): GuardVerdict {
  const data = record(input);
  const times = data && Object.hasOwn(data, "hourlyTimes") ? data.hourlyTimes ?? null : undefined;
  const { reasons, sum } = inspectHourly(data?.hourlyMm, times, limits);
  const reported = data?.reportedTotalMm;
  if (data && Object.hasOwn(data, "reportedTotalMm")) {
    const issue = rainfallIssue(reported, "reportedTotalMm");
    if (issue) reasons.push(issue);
    else if (finite(reported)) {
      if (limits.enabled && reported > limits.max24hMm && !reasons.some((r) => r.code === "TOTAL_EXCEEDS_HARD_CAP")) {
        reasons.push(guardReason("TOTAL_EXCEEDS_HARD_CAP", "reportedTotalMm", reported, "Reported 24-hour rainfall exceeds the engineering cap.", limits.max24hMm));
      } else if (limits.enabled && reported > limits.soft24hMm && reported <= limits.max24hMm && !reasons.some((r) => r.code === "TOTAL_EXCEEDS_SOFT_CAP")) {
        reasons.push(guardReason("TOTAL_EXCEEDS_SOFT_CAP", "reportedTotalMm", reported, "Reported 24-hour rainfall is unusually high for this application.", limits.soft24hMm, "low_confidence"));
      }
      if (sum !== null && Math.abs(reported - sum) > limits.sumToleranceMm + Number.EPSILON * Math.max(1, sum, reported)) {
        reasons.push(guardReason("TOTAL_MISMATCH", "reportedTotalMm", reported, "Reported total differs from the sum of the 24 hours.", limits.sumToleranceMm));
      }
    }
  }
  return combineVerdicts(validateCoordinates(data?.latitude, data?.longitude, limits), guardVerdict(reasons));
}

export function isFeatureEnvelope(value: unknown): value is FeatureEnvelope {
  const envelope = record(value);
  const order = envelope?.featureOrder;
  const ranges = record(envelope?.features);
  return typeof envelope?.generatedAt === "string" && Number.isFinite(Date.parse(envelope.generatedAt))
    && Array.isArray(order) && order.length === FEATURES.length && FEATURES.every((name, i) => order[i] === name)
    && FEATURES.every((name) => {
      const { min, p1, p99, max } = record(ranges?.[name]) ?? {};
      return finite(min) && finite(p1) && finite(p99) && finite(max) && min <= p1 && p1 <= p99 && p99 <= max;
    });
}

export function validateModelFeatures(features: unknown, envelope: unknown, limits: Limits = config.guard): GuardVerdict {
  const values = record(features);
  const reasons: GuardReason[] = [];
  const available = isFeatureEnvelope(envelope);
  for (const name of FEATURES) {
    const value = values?.[name];
    if (!finite(value)) {
      reasons.push(guardReason("NON_FINITE_VALUE", name, value, "Model features must be finite numbers."));
    } else if (limits.enabled && available) {
      const { min, max } = envelope.features[name];
      // Float roundoff is expected for calendar sine/cosine across Python and JS.
      if (value < min - 1e-9 || value > max + 1e-9) {
        reasons.push(guardReason("FEATURE_OUT_OF_TRAINING_RANGE", name, value, "Feature is outside the range observed in the training split.", [min, max], "low_confidence"));
      }
    }
  }
  if (limits.enabled && !available) reasons.push(guardReason("FEATURE_OUT_OF_TRAINING_RANGE", "featureEnvelope", null, "training envelope unavailable", undefined, "low_confidence"));
  return guardVerdict(reasons);
}
