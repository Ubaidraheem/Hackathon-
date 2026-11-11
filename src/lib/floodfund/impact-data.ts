import { config } from "../config";
import { calculateImpact, impactAssumptionsResponse, IMPACT_THRESHOLD_MM, makeImpactAssumptions, type ConfusionCounts, type MeasuredImpact } from "./impact";
import { loadArtifacts } from "./models";
import type { ModelMetrics } from "./types";

const MODEL_NAMES = {
  "ecmwf-aifs": "ECMWF AIFS (raw)",
  "random-forest": "Team Random Forest",
  "neural-network": "Team Neural Network",
} as const;

export const getImpactAssumptions = () => makeImpactAssumptions(config.impact, config.policy.allocationPkr);

const isCount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const isRate = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;

/** Use exact counts if saved. A rate can recover a count only if it implies a whole count. */
export function measuredCounts(metric: Partial<ModelMetrics>): ConfusionCounts | null {
  const { nExamples, referenceAtOrAboveThreshold: reference, predictedAtOrAboveThreshold: predicted } = metric;
  if (!isCount(nExamples) || !isCount(reference) || !isCount(predicted) || reference > nExamples || predicted > nExamples) return null;

  function fromRate(rate: unknown, denominator: number) {
    if (!isRate(rate) || denominator === 0) return undefined;
    const implied = rate * denominator;
    const whole = Math.round(implied);
    return Math.abs(implied - whole) < 1e-7 ? whole : undefined;
  }
  const tp = metric.truePositives
    ?? (isCount(metric.falseTriggers) ? predicted - metric.falseTriggers : undefined)
    ?? (isCount(metric.missedEvents) ? reference - metric.missedEvents : undefined)
    ?? (predicted === 0 || reference === 0 ? 0 : undefined)
    ?? fromRate(metric.precision, predicted)
    ?? fromRate(metric.recall, reference);
  if (!isCount(tp) || tp > Math.min(reference, predicted)) return null;
  const fp = predicted - tp;
  const fn = reference - tp;
  const tn = nExamples - tp - fp - fn;
  if (tn < 0 || (metric.falseTriggers != null && metric.falseTriggers !== fp) || (metric.missedEvents != null && metric.missedEvents !== fn)) return null;
  return { tp, fp, fn, tn };
}

export async function getMeasuredImpact(dir?: string): Promise<MeasuredImpact> {
  const a = getImpactAssumptions();
  const base = { ...impactAssumptionsResponse(a), mode: "measured", thresholdMm: IMPACT_THRESHOLD_MM } as const;
  const unavailable = (reason: string): MeasuredImpact => ({
    ...base, status: "unavailable", reason, benchmarkGeneratedAt: null, models: [],
  });
  const { benchmark } = await loadArtifacts(dir);
  if (!benchmark) return unavailable("The saved benchmark.json is missing or unreadable. Restore the original benchmark to see measured results.");
  if (benchmark.dataKind !== "real" || benchmark.thresholdMm !== IMPACT_THRESHOLD_MM || benchmark.sameRowsVerified !== true) {
    return unavailable("A real, matched-row benchmark at the 80 mm threshold is required.");
  }
  const metrics = benchmark.test?.metrics;
  if (!Array.isArray(metrics)) return unavailable("The saved benchmark does not contain test metrics.");
  const models: MeasuredImpact["models"] = [];
  let totals: { reference: number; examples: number } | undefined;
  for (const modelId of Object.keys(MODEL_NAMES) as (keyof typeof MODEL_NAMES)[]) {
    const entries = metrics.filter((metric) => metric?.modelId === modelId);
    const counts = entries.length === 1 ? measuredCounts(entries[0]) : null;
    if (!counts) return unavailable(`The saved test counts for ${MODEL_NAMES[modelId]} are incomplete or inconsistent.`);
    const reference = counts.tp + counts.fn;
    const examples = entries[0].nExamples;
    if (totals && (totals.reference !== reference || totals.examples !== examples)) return unavailable("Models must be evaluated on the same reference events.");
    totals = { reference, examples };
    const result = calculateImpact(counts, a);
    if (!result.ok) return unavailable(result.error.message);
    models.push({ modelId, name: MODEL_NAMES[modelId], impact: result.data });
  }
  return { ...base, status: "available", reason: null, benchmarkGeneratedAt: typeof benchmark.generatedAt === "string" ? benchmark.generatedAt : null, models };
}
