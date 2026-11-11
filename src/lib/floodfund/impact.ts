import type { ModelId } from "./types";

export const IMPACT_ASSUMPTION = "ASSUMPTION - replace with municipal data";
export const IMPACT_DISCLAIMER = "Illustrative impact model based on stated assumptions. All funding is simulated.";
export const IMPACT_THRESHOLD_MM = 80;

interface Assumption<T> {
  value: T;
  unit: "PKR" | "fraction" | "mode";
  label: string;
  sourceNote: string;
  flag: typeof IMPACT_ASSUMPTION;
}

export const IMPACT_INPUTS = {
  portfolioAssetValuePkr: { label: "Portfolio asset value", unit: "PKR", max: 100_000_000_000, step: 1, note: "Illustrative Karachi asset portfolio. Use the municipal asset register." },
  exposedFractionPerEvent: { label: "Portfolio exposed per event", unit: "fraction", max: 1, step: "any", note: "Illustrative share of assets exposed. Use event footprints matched to the asset register." },
  damageRatio: { label: "Damage ratio", unit: "fraction", max: 1, step: "any", note: "Illustrative share of exposed value damaged. Use historical loss records." },
  mitigationEffectiveness: { label: "Mitigation effectiveness", unit: "fraction", max: 1, step: "any", note: "Illustrative share of loss avoided by timely action. Use evidence from preparedness programmes." },
  falseAlarmExtraCostPkr: { label: "Extra operational cost per false alarm", unit: "PKR", max: 1_000_000_000, step: 1, note: "Illustrative cost above the simulated policy allocation. Use municipal response costs." },
} as const;

type Editable = keyof typeof IMPACT_INPUTS;
const INPUT_KEYS = Object.keys(IMPACT_INPUTS) as Editable[];
export type ImpactValues = Record<Editable, number>;
export type ImpactAssumptions = Record<Editable, Assumption<number>> & {
  allocationCostPkr: Assumption<number>;
  falseAlarmCostPkr: Assumption<number>;
  missedEventCostMode: Assumption<"exposure_only">;
};

export interface ConfusionCounts { tp: number; fp: number; fn: number; tn: number | null }
export interface ScenarioInput { eventCount: number; recall: number; falseAlarmCount: number }
export const MAX_EVENTS = 10_000;
export const IMPACT_PRESETS = [
  { id: "conservative", title: "Conservative", eventCount: 10, recall: 0.5, falseAlarmCount: 2 },
  { id: "balanced", title: "Balanced", eventCount: 10, recall: 0.7, falseAlarmCount: 5 },
  { id: "aggressive", title: "Aggressive", eventCount: 10, recall: 0.9, falseAlarmCount: 100 },
] as const;

export interface ImpactBreakdown {
  counts: ConfusionCounts;
  lossPerEventPkr: number;
  lossAvertedPerTruePositivePkr: number;
  grossLossAvertedPkr: number;
  falseAlarmCostTotalPkr: number;
  netFinancialGainPkr: number;
  fullyLoadedNetPkr: number;
  missedEventExposurePkr: number;
  trueDetectionSpendPkr: number;
  totalSimulatedSpendPkr: number;
  breakEvenTpToFpRatio: number | null;
  breakEvenPrecision: number | null;
  breakEvenReason: string | null;
  returnOnSpend: number | null;
}

interface ImpactBase { disclaimer: typeof IMPACT_DISCLAIMER; assumptionsUsed: ImpactAssumptions }
export interface SensitivityRow { damageRatio: number; points: { mitigationEffectiveness: number; netFinancialGainPkr: number }[] }
export interface ScenarioImpact extends ImpactBase {
  mode: "what-if";
  input: ScenarioInput;
  impact: ImpactBreakdown;
  sensitivity: SensitivityRow[];
  falseAlarmCurve: { falseAlarmCount: number; netFinancialGainPkr: number }[];
}
export interface MeasuredImpact extends ImpactBase {
  mode: "measured";
  status: "available" | "unavailable";
  reason: string | null;
  thresholdMm: number;
  benchmarkGeneratedAt: string | null;
  models: { modelId: ModelId; name: string; impact: ImpactBreakdown }[];
}
export interface SessionImpact extends ImpactBase {
  mode: "simulated-session";
  simulated: true;
  allocationCount: number;
  simulatedSpendPkr: number;
  breakEvenTrueDetections: number | null;
  breakEvenReason: string | null;
}
export type ImpactResult<T> = { ok: true; data: T } | { ok: false; error: { field: string; message: string } };

const invalid = (field: string, message: string): ImpactResult<never> => ({ ok: false, error: { field, message } });
const success = <T>(data: T): ImpactResult<T> => ({ ok: true, data });
const numberIn = (v: unknown, max: number, integer = false): v is number =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= max && (!integer || Number.isSafeInteger(v));
const record = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null;

function assumption<T>(value: T, unit: Assumption<T>["unit"], label: string, sourceNote: string): Assumption<T> {
  return { value, unit, label, sourceNote, flag: IMPACT_ASSUMPTION };
}

export function makeImpactAssumptions(values: ImpactValues, allocationCostPkr: number): ImpactAssumptions {
  const editable = Object.fromEntries(INPUT_KEYS.map((key) => {
    const spec = IMPACT_INPUTS[key];
    return [key, assumption(values[key], spec.unit, spec.label, spec.note)];
  })) as Record<Editable, Assumption<number>>;
  return {
    ...editable,
    allocationCostPkr: assumption(allocationCostPkr, "PKR", "Spend per true detection", "Configured simulated policy allocation per event."),
    falseAlarmCostPkr: assumption(allocationCostPkr + values.falseAlarmExtraCostPkr, "PKR", "Total cost per false alarm", "Simulated policy allocation plus assumed extra operational cost."),
    missedEventCostMode: assumption("exposure_only", "mode", "Missed-event cost treatment", "Show unmitigated loss separately as exposure."),
  };
}

export function impactAssumptionsResponse(assumptionsUsed: ImpactAssumptions): ImpactBase {
  return { assumptionsUsed, disclaimer: IMPACT_DISCLAIMER };
}

function assumptionsError(a: ImpactAssumptions): ImpactResult<never> | null {
  for (const key of INPUT_KEYS) {
    const spec = IMPACT_INPUTS[key];
    if (!numberIn(a?.[key]?.value, spec.max, spec.unit === "PKR")) return invalid(key, `Must be a ${spec.unit === "PKR" ? "whole number" : "number"} from 0 to ${spec.max}.`);
  }
  if (!numberIn(a.allocationCostPkr?.value, 1_000_000_000, true)) return invalid("allocationCostPkr", "Must be a whole number from 0 to 1000000000.");
  if (a.falseAlarmCostPkr?.value !== a.allocationCostPkr.value + a.falseAlarmExtraCostPkr.value) return invalid("falseAlarmCostPkr", "Must equal the simulated allocation plus the extra operational cost.");
  if (a.missedEventCostMode?.value !== "exposure_only") return invalid("missedEventCostMode", "Missed-event cost must be reported as exposure.");
  return null;
}

// Interpret accepted decimal numbers exactly as serialized. BigInt products
// preserve half-rupee boundaries and are converted only after final rounding.
type Decimal = { n: bigint; d: bigint };
const ZERO = BigInt(0);
const ONE = BigInt(1);
const TWO = BigInt(2);
const TEN = BigInt(10);
function decimal(value: number): Decimal {
  const [coefficient, exponent = "0"] = value.toString().split("e");
  const [whole, fractional = ""] = coefficient.split(".");
  const places = fractional.length - Number(exponent);
  const digits = BigInt(whole + fractional);
  return places < 0 ? { n: digits * TEN ** BigInt(-places), d: ONE } : { n: digits, d: TEN ** BigInt(places) };
}
function scale(value: Decimal, factor: number): Decimal {
  const f = decimal(factor);
  return { n: value.n * f.n, d: value.d * f.d };
}
const rounded = ({ n, d }: Decimal) => Number((TWO * n + d) / (TWO * d));

function eventLoss(a: ImpactAssumptions) {
  const exposed = scale(decimal(a.portfolioAssetValuePkr.value), a.exposedFractionPerEvent.value);
  const loss = scale(exposed, a.damageRatio.value);
  return { loss, averted: scale(loss, a.mitigationEffectiveness.value) };
}

export function calculateImpact(counts: ConfusionCounts, assumptions: ImpactAssumptions): ImpactResult<ImpactBreakdown> {
  const error = assumptionsError(assumptions);
  if (error) return error;
  for (const key of ["tp", "fp", "fn", "tn"] as const) {
    const value = counts?.[key];
    if (key === "tn" && value === null) continue;
    if (!numberIn(value, MAX_EVENTS, true)) return invalid(key, `Must be a whole number from 0 to ${MAX_EVENTS}.`);
  }
  const { loss, averted } = eventLoss(assumptions);
  const cost = assumptions.falseAlarmCostPkr.value;
  const grossLossAvertedPkr = rounded(scale(averted, counts.tp));
  const falseAlarmCostTotalPkr = counts.fp * cost;
  const netFinancialGainPkr = grossLossAvertedPkr - falseAlarmCostTotalPkr;
  const trueDetectionSpendPkr = counts.tp * assumptions.allocationCostPkr.value;
  const totalSimulatedSpendPkr = falseAlarmCostTotalPkr + trueDetectionSpendPkr;
  const breakEven = averted.n === ZERO ? null : BigInt(cost) * averted.d;
  const ratio = breakEven === null ? null : Number(breakEven) / Number(averted.n);
  const precision = ratio === null ? null : 1 / (1 + 1 / ratio);
  // Very small nonzero fractions can make a ratio unrepresentable as a JSON number.
  const breakEvenTpToFpRatio = ratio !== null && Number.isFinite(ratio) ? ratio : null;
  return success({
    counts, lossPerEventPkr: rounded(loss), lossAvertedPerTruePositivePkr: rounded(averted),
    grossLossAvertedPkr, falseAlarmCostTotalPkr, netFinancialGainPkr,
    fullyLoadedNetPkr: netFinancialGainPkr - trueDetectionSpendPkr,
    missedEventExposurePkr: rounded(scale(loss, counts.fn)),
    trueDetectionSpendPkr, totalSimulatedSpendPkr, breakEvenTpToFpRatio,
    breakEvenPrecision: precision !== null && Number.isFinite(precision) ? precision : null,
    breakEvenReason: averted.n === ZERO ? "Assumed loss averted per detection is zero."
      : breakEvenTpToFpRatio === null ? "Break-even ratio is outside the representable range." : null,
    returnOnSpend: totalSimulatedSpendPkr === 0 ? null : netFinancialGainPkr / totalSimulatedSpendPkr,
  });
}

const GRID = [0, 0.25, 0.5, 0.75, 1];

function withFractions(a: ImpactAssumptions, damageRatio: number, mitigationEffectiveness: number): ImpactAssumptions {
  return {
    ...a,
    damageRatio: { ...a.damageRatio, value: damageRatio },
    mitigationEffectiveness: { ...a.mitigationEffectiveness, value: mitigationEffectiveness },
  };
}

export function impactSensitivity(counts: ConfusionCounts, a: ImpactAssumptions): ImpactResult<SensitivityRow[]> {
  const base = calculateImpact(counts, a);
  if (!base.ok) return base;
  const cost = base.data.falseAlarmCostTotalPkr;
  return success(GRID.map((damageRatio) => ({
    damageRatio,
    points: GRID.map((mitigationEffectiveness) => {
      const { averted } = eventLoss(withFractions(a, damageRatio, mitigationEffectiveness));
      return { mitigationEffectiveness, netFinancialGainPkr: rounded(scale(averted, counts.tp)) - cost };
    }),
  })));
}

export function calculateScenario(body: unknown, defaults: ImpactAssumptions): ImpactResult<ScenarioImpact> {
  const input = record(body);
  if (!input || Object.keys(input).some((key) => !["eventCount", "recall", "falseAlarmCount", "overrides"].includes(key))) {
    return invalid("body", "Supply eventCount, recall, falseAlarmCount and optional overrides.");
  }
  const { eventCount, recall, falseAlarmCount } = input;
  if (!numberIn(eventCount, MAX_EVENTS, true)) return invalid("eventCount", `Must be a whole number from 0 to ${MAX_EVENTS}.`);
  if (!numberIn(recall, 1)) return invalid("recall", "Must be a number from 0 to 1.");
  if (!numberIn(falseAlarmCount, MAX_EVENTS, true)) return invalid("falseAlarmCount", `Must be a whole number from 0 to ${MAX_EVENTS}.`);
  const overrides = Object.hasOwn(input, "overrides") ? record(input.overrides) : {};
  if (!overrides || Object.keys(overrides).some((key) => !Object.hasOwn(IMPACT_INPUTS, key))) return invalid("overrides", "Only the documented adjustable assumptions can be overridden.");
  const values = {} as ImpactValues;
  for (const key of INPUT_KEYS) {
    const spec = IMPACT_INPUTS[key];
    const value = Object.hasOwn(overrides, key) ? overrides[key] : defaults[key].value;
    if (!numberIn(value, spec.max, spec.unit === "PKR")) return invalid(key, `Must be a ${spec.unit === "PKR" ? "whole number" : "number"} from 0 to ${spec.max}.`);
    values[key] = value;
  }
  const a = makeImpactAssumptions(values, defaults.allocationCostPkr.value);
  const tp = rounded(scale(decimal(eventCount), recall));
  const counts = { tp, fp: falseAlarmCount, fn: eventCount - tp, tn: null };
  const impact = calculateImpact(counts, a);
  if (!impact.ok) return impact;
  const sensitivity = impactSensitivity(counts, a);
  if (!sensitivity.ok) return sensitivity;
  const alarmCost = a.falseAlarmCostPkr.value;
  const crossing = alarmCost === 0 ? 0 : Math.ceil(impact.data.grossLossAvertedPkr / alarmCost) + 1;
  const max = Math.min(MAX_EVENTS, Math.max(10, falseAlarmCount * 2, crossing));
  const steps = [...new Set([...Array.from({ length: 11 }, (_, i) => Math.round(i * max / 10)), falseAlarmCount])].sort((x, y) => x - y);
  return success({
    ...impactAssumptionsResponse(a), mode: "what-if", input: { eventCount, recall, falseAlarmCount },
    impact: impact.data, sensitivity: sensitivity.data,
    falseAlarmCurve: steps.map((fp) => ({ falseAlarmCount: fp, netFinancialGainPkr: impact.data.grossLossAvertedPkr - fp * a.falseAlarmCostPkr.value })),
  });
}

export function calculateSessionImpact(allocationCount: number, simulatedSpendPkr: number, a: ImpactAssumptions): ImpactResult<SessionImpact> {
  const error = assumptionsError(a);
  if (error) return error;
  if (!numberIn(allocationCount, Number.MAX_SAFE_INTEGER, true) || !numberIn(simulatedSpendPkr, Number.MAX_SAFE_INTEGER, true)) {
    return invalid("simulatedSpendPkr", "Session counts and spend must be safe nonnegative integers.");
  }
  const { averted } = eventLoss(a);
  const needed = averted.n === ZERO ? null : (BigInt(simulatedSpendPkr) * averted.d + averted.n - ONE) / averted.n;
  const breakEvenTrueDetections = needed !== null && needed <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(needed) : null;
  return success({
    ...impactAssumptionsResponse(a), mode: "simulated-session", simulated: true, allocationCount, simulatedSpendPkr,
    breakEvenTrueDetections,
    breakEvenReason: averted.n === ZERO ? "Assumed loss averted per detection is zero."
      : breakEvenTrueDetections === null ? "Required detection count exceeds the safe integer range." : null,
  });
}
