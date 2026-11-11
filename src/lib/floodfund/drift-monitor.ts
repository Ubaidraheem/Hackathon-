import { promises as fs } from "node:fs";
import path from "node:path";
import { config } from "../config";
import { evaluateDrift, isDriftSample, OBSERVATION_LAG_NOTE, type DriftResult } from "./drift";
import { FEATURES, type FeatureName } from "./ml-runtime";
import { HOUR_MS, utcDayStart } from "./time";
import type { ComparisonPrediction } from "./types";

type TeamModel = "random-forest" | "neural-network";
type Columns = Record<FeatureName, number[]>;
interface DriftReference {
  generatedAt: string;
  trainingEnd: string | null;
  features: Columns;
  residuals?: { modelId: TeamModel; validationEnd: string; values: number[] };
}
interface Sample {
  date: string;
  directory: string;
  features: Record<FeatureName, number>;
  residuals: Partial<Record<TeamModel, number>>;
}

const LOOKBACK_DAYS = 90;
const MAX_RECENT_COMPARISONS = 2 * LOOKBACK_DAYS;
const globalSamples = globalThis as typeof globalThis & { __ffDriftSamples?: Map<string, Sample> };
const samples = globalSamples.__ffDriftSamples ??= new Map<string, Sample>();
const artifactDir = (dir?: string) => path.resolve(/*turbopackIgnore: true*/ process.cwd(), dir ?? config.artifactsDir);
const object = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null;
const date = (v: unknown): v is string => typeof v === "string" && utcDayStart(v) !== null;
const teamModel = (v: unknown): v is TeamModel => v === "random-forest" || v === "neural-network";

export function parseDriftReference(value: unknown): DriftReference | null {
  const file = object(value);
  if (!file || typeof file.generatedAt !== "string" || !Number.isFinite(Date.parse(file.generatedAt))) return null;
  const order = file.featureOrder;
  if (!Array.isArray(order) || order.length !== FEATURES.length || !FEATURES.every((name, i) => order[i] === name)) return null;
  const features = object(file.features);
  if (!features || !FEATURES.every((name) => isDriftSample(features[name]))) return null;
  if (file.trainingEnd !== undefined && !date(file.trainingEnd)) return null;
  const trainingEnd = typeof file.trainingEnd === "string" ? file.trainingEnd : null;
  if (file.residuals === undefined) return { generatedAt: file.generatedAt, trainingEnd, features: features as Columns };
  const r = object(file.residuals);
  if (!r || !teamModel(r.modelId) || !date(r.validationEnd) || (trainingEnd && r.validationEnd <= trainingEnd) || !isDriftSample(r.values)) return null;
  return {
    generatedAt: file.generatedAt, trainingEnd, features: features as Columns,
    residuals: { modelId: r.modelId, validationEnd: r.validationEnd, values: r.values },
  };
}

/** Reuse the fixed-day features and already-fetched observation from the comparison pipeline. */
export function rememberDriftComparison(
  targetDate: string,
  features: Sample["features"],
  observedMm: number | null,
  predictions: readonly ComparisonPrediction[],
  dir?: string,
) {
  if (!config.drift.enabled) return;
  const directory = artifactDir(dir);
  const residuals: Sample["residuals"] = {};
  if (observedMm !== null) for (const p of predictions) {
    if (teamModel(p.modelId) && p.status === "ok" && p.rainfallMm !== null) {
      const difference = p.rainfallMm - observedMm;
      if (Number.isFinite(difference)) residuals[p.modelId] = difference;
    }
  }
  const key = `${directory}|${targetDate}`;
  samples.delete(key);
  samples.set(key, { date: targetDate, directory, features, residuals });
  if (samples.size > MAX_RECENT_COMPARISONS) {
    const oldest = samples.keys().next().value;
    if (oldest !== undefined) samples.delete(oldest);
  }
}

export type LiveDriftStatus = { dataKind: "live"; observationNote: string } & (
  | { status: "unavailable"; reason: string; result: null }
  | {
    status: "available"; reason: null; result: DriftResult;
    referenceGeneratedAt: string; lookbackDays: number; sampleCount: number;
    windowStart: string | null; windowEnd: string | null;
  }
);

/** Read-only diagnostic. Never fetches weather or queries session state. */
export async function getDriftStatus(nowMs = Date.now(), dir?: string): Promise<LiveDriftStatus> {
  const base = { dataKind: "live", observationNote: OBSERVATION_LAG_NOTE } as const;
  const unavailable = (reason: string): LiveDriftStatus => ({ ...base, status: "unavailable", reason, result: null });
  if (!config.drift.enabled) return unavailable("Drift monitoring is disabled.");
  const directory = artifactDir(dir);
  let reference: DriftReference | null;
  try {
    reference = parseDriftReference(JSON.parse(await fs.readFile(path.join(directory, "drift_reference.json"), "utf8")));
  } catch {
    return unavailable("Drift reference unavailable. Restore drift_reference.json from the original training pipeline.");
  }
  if (!reference) return unavailable("Drift reference unavailable. The artifact does not match the documented schema.");
  const today = Math.floor(nowMs / (24 * HOUR_MS)) * 24 * HOUR_MS;
  const start = new Date(today - LOOKBACK_DAYS * 24 * HOUR_MS).toISOString().slice(0, 10);
  const end = new Date(today).toISOString().slice(0, 10);
  const recent = [...samples.values()].filter((s) => s.directory === directory && s.date >= start && s.date < end &&
    (!reference.trainingEnd || s.date > reference.trainingEnd)).sort((a, b) => a.date.localeCompare(b.date));
  const current = Object.fromEntries(FEATURES.map((name) => [name, recent.map((s) => s.features[name])])) as Columns;
  const r = reference.residuals;
  const residuals = r && {
    modelId: r.modelId,
    reference: r.values,
    current: recent.flatMap((s) => {
      const residual = s.residuals[r.modelId];
      return s.date > r.validationEnd && residual !== undefined ? [residual] : [];
    }),
  };
  return {
    ...base, status: "available", reason: null,
    result: evaluateDrift({ reference: reference.features, current, currentDates: recent.map((s) => s.date), residuals }),
    referenceGeneratedAt: reference.generatedAt, lookbackDays: LOOKBACK_DAYS, sampleCount: recent.length,
    windowStart: recent[0]?.date ?? null, windowEnd: recent.at(-1)?.date ?? null,
  };
}
