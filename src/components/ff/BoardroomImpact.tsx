"use client";

import { Download, RotateCcw, Scale } from "lucide-react";
import { useEffect, useState } from "react";
import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { api } from "@/lib/api-client";
import {
  calculateScenario, calculateSessionImpact, IMPACT_ASSUMPTION, IMPACT_DISCLAIMER, IMPACT_INPUTS, IMPACT_PRESETS, MAX_EVENTS,
  type ImpactAssumptions, type ImpactBreakdown, type MeasuredImpact, type ScenarioImpact,
} from "@/lib/floodfund/impact";
import type { Budget } from "@/lib/floodfund/types";
import { fmtPkr, Glass } from "./ui";

const MODES = [
  { id: "measured", title: "Measured" },
  { id: "what-if", title: "What-if" },
  { id: "simulated-session", title: "This session" },
] as const;
type Mode = (typeof MODES)[number]["id"];
type Inputs = keyof typeof IMPACT_INPUTS;
const keys = Object.keys(IMPACT_INPUTS) as Inputs[];
const percent = (v: number) => new Intl.NumberFormat("en", { style: "percent", maximumFractionDigits: 2 }).format(v);
const buttonStyle = "inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-white/15 px-3 text-sm font-medium text-slate-200 hover:bg-white/10 disabled:opacity-50";
const inputStyle = "mt-1 block min-h-11 w-full rounded-lg border border-white/20 bg-[#071226] px-3 text-sm text-white";
const equation = "Net Financial Gain = Loss Averted by True Detections - Operational Cost of False Alarms";

function assumptionValue(a: ImpactAssumptions[keyof ImpactAssumptions]) {
  if (typeof a.value === "string") return "Show as exposure";
  return a.unit === "PKR" ? fmtPkr(a.value) : percent(a.value);
}

function ratios(impact: ImpactBreakdown) {
  return impact.breakEvenTpToFpRatio === null ? "Unavailable"
    : `${impact.breakEvenTpToFpRatio.toLocaleString("en-US", { maximumSignificantDigits: 4 })}:1`;
}

function impactLines(impact: ImpactBreakdown) {
  const { tp, fp, fn, tn } = impact.counts;
  return [
    `- True detections: ${tp}; false alarms: ${fp}; missed events: ${fn}; true negatives: ${tn ?? "unavailable"}`,
    `- Headline gain: ${fmtPkr(impact.netFinancialGainPkr)}`,
    `- Gross loss averted: ${fmtPkr(impact.grossLossAvertedPkr)}`,
    `- False-alarm cost: ${fmtPkr(impact.falseAlarmCostTotalPkr)}`,
    `- Fully loaded net: ${fmtPkr(impact.fullyLoadedNetPkr)}`,
    `- Missed-event exposure: ${fmtPkr(impact.missedEventExposurePkr)}`,
    `- Total simulated spend: ${fmtPkr(impact.totalSimulatedSpendPkr)}`,
    `- Break-even TP:FP: ${ratios(impact)}${impact.breakEvenReason ? ` (${impact.breakEvenReason})` : ""}`,
    `- Break-even precision: ${impact.breakEvenPrecision === null ? "Unavailable" : percent(impact.breakEvenPrecision)}`,
    `- Return on simulated spend: ${impact.returnOnSpend === null ? "Unavailable" : percent(impact.returnOnSpend)}`,
  ];
}

function exportSummary(title: string, lines: string[], assumptions: ImpactAssumptions) {
  const markdown = [
    `# FloodFund Karachi — Boardroom impact · ${title}`, "", IMPACT_DISCLAIMER, "", IMPACT_ASSUMPTION, "",
    equation, "", ...lines, "", "## Assumptions", "",
    ...Object.values(assumptions).map((a) => `- ${a.label}: ${assumptionValue(a)}. ${a.flag}. ${a.sourceNote}`),
  ].join("\n");
  const url = URL.createObjectURL(new Blob([markdown], { type: "text/markdown;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = "floodfund-boardroom-impact.md";
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function Headline({ impact }: { impact: ImpactBreakdown }) {
  const cards = [
    ["Net financial gain", fmtPkr(impact.netFinancialGainPkr)],
    ["Loss averted", fmtPkr(impact.grossLossAvertedPkr)],
    ["False-alarm cost", fmtPkr(impact.falseAlarmCostTotalPkr)],
    ["Missed-event exposure", fmtPkr(impact.missedEventExposurePkr)],
    ["Break-even TP:FP", ratios(impact)],
  ];
  return (
    <div className="space-y-3">
      <dl className="grid gap-2 sm:grid-cols-2 xl:grid-cols-5">
        {cards.map(([label, value]) => (
          <div key={label} className="min-w-0 rounded-xl border border-white/10 bg-[#071226] p-3">
            <dt className="text-xs text-slate-400">{label}</dt>
            <dd className="ff-num mt-1 break-words text-lg font-semibold text-white">{value}</dd>
          </div>
        ))}
      </dl>
      <p className="text-sm leading-relaxed text-slate-300">
        <strong className="text-white">{fmtPkr(impact.netFinancialGainPkr)}</strong>
        {" = "}{fmtPkr(impact.grossLossAvertedPkr)}{" − "}{fmtPkr(impact.falseAlarmCostTotalPkr)}
      </p>
      <p className="text-sm leading-relaxed text-slate-300">
        Fully loaded net <strong className="text-white">{fmtPkr(impact.fullyLoadedNetPkr)}</strong> after {fmtPkr(impact.trueDetectionSpendPkr)} in simulated true-detection spend.
        {" "}Break-even precision {impact.breakEvenPrecision === null ? "unavailable" : percent(impact.breakEvenPrecision)}.
        {" "}Return on simulated spend {impact.returnOnSpend === null ? "unavailable (zero spend)" : percent(impact.returnOnSpend)}.
      </p>
      {impact.breakEvenReason && <p className="text-sm text-slate-400">{impact.breakEvenReason}</p>}
    </div>
  );
}

function Sensitivity({ scenario }: { scenario: ScenarioImpact }) {
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <figure className="min-w-0 rounded-xl border border-white/10 p-3">
        <figcaption className="text-sm font-semibold text-white">What-if gain by false-alarm count</figcaption>
        <p className="mt-1 text-xs text-slate-400">True detections are fixed at {scenario.impact.counts.tp}. Vertical values are in PKR.</p>
        <div className="mt-3 h-60" aria-label="Assumption-based line chart of net financial gain by false-alarm count">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={scenario.falseAlarmCurve} margin={{ left: 4, right: 14, bottom: 12, top: 6 }}>
              <CartesianGrid stroke="rgba(148,197,255,0.12)" vertical={false} />
              <XAxis dataKey="falseAlarmCount" type="number" tick={{ fill: "#a6b8cd", fontSize: 10 }} label={{ value: "False alarms", position: "insideBottom", offset: -9, fill: "#a6b8cd", fontSize: 10 }} />
              <YAxis width={54} tick={{ fill: "#a6b8cd", fontSize: 10 }} tickFormatter={(value: number) => Intl.NumberFormat("en", { notation: "compact" }).format(value)} />
              <ReferenceLine y={0} stroke="#94a3b8" strokeDasharray="4 4" />
              <Tooltip formatter={(value) => [fmtPkr(Number(value)), "Assumed net gain"]} labelFormatter={(value) => `False alarms: ${value}`} contentStyle={{ backgroundColor: "#071226", borderColor: "#334155" }} />
              <Line dataKey="netFinancialGainPkr" stroke="#67e8f9" strokeWidth={2} dot={false} isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </figure>
      <div className="min-w-0 overflow-x-auto rounded-xl border border-white/10 p-3">
        <table className="w-full text-left text-xs text-slate-200">
          <caption className="mb-3 text-left text-sm font-semibold text-white">What-if net gain by damage and mitigation (PKR)</caption>
          <thead>
            <tr>
              <th scope="col" className="p-2">Damage ↓ / mitigation →</th>
              {scenario.sensitivity[0].points.map((p) => <th className="p-2" key={p.mitigationEffectiveness} scope="col">{percent(p.mitigationEffectiveness)}</th>)}
            </tr>
          </thead>
          <tbody>
            {scenario.sensitivity.map((row) => (
              <tr key={row.damageRatio}>
                <th className="p-2" scope="row">{percent(row.damageRatio)}</th>
                {row.points.map((p) => (
                  <td key={p.mitigationEffectiveness} className={`whitespace-nowrap border border-white/10 p-2 ff-num ${p.netFinancialGainPkr < 0 ? "bg-red-500/10" : p.netFinancialGainPkr > 0 ? "bg-emerald-500/10" : ""}`}>{p.netFinancialGainPkr.toLocaleString("en-US")}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const SCENARIO_FIELDS = [
  { id: "eventCount", title: "Reference events per season", step: 1, max: MAX_EVENTS },
  { id: "recall", title: "Recall (0 to 1)", step: "any", max: 1 },
  { id: "falseAlarmCount", title: "False alarms per season", step: 1, max: MAX_EVENTS },
] as const;
type ScenarioField = (typeof SCENARIO_FIELDS)[number]["id"];
function presetFields(preset: (typeof IMPACT_PRESETS)[number]): Record<ScenarioField, string> {
  return { eventCount: String(preset.eventCount), recall: String(preset.recall), falseAlarmCount: String(preset.falseAlarmCount) };
}
const inputNumber = (raw: string) => raw.trim() === "" ? NaN : Number(raw);

export default function BoardroomImpact({ budget, driftFlagged }: { budget: Budget; driftFlagged?: boolean }) {
  const [mode, setMode] = useState<Mode>("measured");
  const [defaults, setDefaults] = useState<ImpactAssumptions | null>(null);
  const [measured, setMeasured] = useState<MeasuredImpact | null>(null);
  const [defaultsError, setDefaultsError] = useState<string | null>(null);
  const [measuredError, setMeasuredError] = useState<string | null>(null);
  const [modelId, setModelId] = useState("ecmwf-aifs");
  const [fields, setFields] = useState(() => presetFields(IMPACT_PRESETS[1]));
  const [overrides, setOverrides] = useState<Partial<Record<Inputs, string>>>({});

  useEffect(() => {
    let active = true;
    api.impactAssumptions().then(
      (data) => { if (active) setDefaults(data.assumptionsUsed); },
      (error: unknown) => { if (active) setDefaultsError(error instanceof Error ? error.message : "Impact assumptions could not be loaded."); },
    );
    api.measuredImpact().then(
      (data) => { if (active) setMeasured(data); },
      (error: unknown) => { if (active) setMeasuredError(error instanceof Error ? error.message : "The benchmark could not be loaded."); },
    );
    return () => { active = false; };
  }, []);

  const scenario = mode === "what-if" && defaults ? calculateScenario({
    eventCount: inputNumber(fields.eventCount), recall: inputNumber(fields.recall), falseAlarmCount: inputNumber(fields.falseAlarmCount),
    overrides: Object.fromEntries(keys.flatMap((key) => overrides[key] === undefined ? [] : [[key, inputNumber(overrides[key])]])),
  }, defaults) : null;
  const session = mode === "simulated-session" && defaults ? calculateSessionImpact(budget.allocationCount, budget.allocatedPkr, defaults) : null;
  const assumptionsUsed = mode === "measured" ? measured?.assumptionsUsed : scenario?.ok ? scenario.data.assumptionsUsed : defaults;
  const selected = measured?.models.find((model) => model.modelId === modelId);
  const singleMiss = measured?.status === "available" && measured.models.every(({ impact }) => impact.counts.tp === 0 && impact.counts.fn === 1);

  function download() {
    if (mode === "what-if" && scenario?.ok) {
      const { data } = scenario;
      exportSummary("Illustrative what-if", [
        `- Assumed events: ${data.input.eventCount}; assumed recall: ${percent(data.input.recall)}; assumed false alarms: ${data.input.falseAlarmCount}`,
        ...impactLines(data.impact),
      ], data.assumptionsUsed);
    } else if (mode === "measured" && measured) {
      exportSummary("Measured benchmark counts", selected ? [
        `- Model: ${selected.name}; benchmark threshold: ≥ ${measured.thresholdMm} mm`,
        ...impactLines(selected.impact),
      ] : [`- Measured mode unavailable. ${measured.reason ?? ""}`], measured.assumptionsUsed);
    } else if (mode === "simulated-session" && session?.ok) {
      exportSummary("Simulated session", [
        `- Recorded simulated allocations: ${session.data.allocationCount}`,
        `- Recorded simulated spend: ${fmtPkr(session.data.simulatedSpendPkr)}`,
        `- Assumed detections needed to cover spend: ${session.data.breakEvenTrueDetections ?? session.data.breakEvenReason}`,
      ], session.data.assumptionsUsed);
    }
  }

  return (
    <Glass className="min-w-0 space-y-4 p-5 sm:p-6" aria-labelledby="impact-title">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="ff-eyebrow">C15</p>
          <h2 id="impact-title" className="mt-1 flex items-center gap-2 text-lg font-semibold text-white"><Scale size={18} aria-hidden="true" /> Boardroom impact</h2>
          <p className="mt-1 text-sm text-slate-300">{IMPACT_DISCLAIMER}</p>
          <p className="mt-1 text-xs font-semibold text-amber-200">{IMPACT_ASSUMPTION}</p>
        </div>
        <button type="button" className={buttonStyle} onClick={download} disabled={mode === "measured" ? !measured : mode === "what-if" ? !scenario?.ok : !session?.ok}>
          <Download size={15} aria-hidden="true" /> Export boardroom summary
        </button>
      </div>
      <div role="group" aria-label="Impact mode" className="flex flex-wrap gap-2">
        {MODES.map((item) => (
          <button key={item.id} type="button" onClick={() => setMode(item.id)} aria-pressed={mode === item.id} className={`${buttonStyle} aria-pressed:border-cyan-300/60 aria-pressed:bg-cyan-300/15`}>{item.title}</button>
        ))}
      </div>
      <p className="text-sm font-medium text-white">{equation}</p>
      {driftFlagged && <p className="text-sm text-amber-200">Model drift flagged: post-processor financial estimates are less reliable.</p>}

      {mode === "measured" && (
        <div className="space-y-3">
          {measuredError && <p role="alert" className="text-sm text-red-200">{measuredError}</p>}
          {!measured && !measuredError && <p role="status" className="text-sm text-slate-400">Loading saved benchmark…</p>}
          {measured?.status === "unavailable" && <p role="status" className="rounded-lg border border-amber-300/30 bg-amber-400/10 p-3 text-sm text-amber-100">{measured.reason}</p>}
          {singleMiss && <p className="rounded-lg border border-amber-300/30 bg-amber-400/10 p-3 text-sm text-amber-100">Benchmark contains one ≥ 80 mm event; no model detected it. No financial gain is claimed.</p>}
          {measured?.status === "available" && selected && (
            <>
              <label className="block max-w-sm text-sm font-medium text-white">
                Saved test benchmark model
                <select value={modelId} onChange={(e) => setModelId(e.target.value)} className={inputStyle}>
                  {measured.models.map((model) => <option key={model.modelId} value={model.modelId}>{model.name}</option>)}
                </select>
              </label>
              <p className="text-sm text-slate-300">{selected.impact.counts.tp} true detections · {selected.impact.counts.fp} false alarms · {selected.impact.counts.fn} missed events · {selected.impact.counts.tn} true negatives. PKR values apply the stated assumptions to those counts.</p>
              <Headline impact={selected.impact} />
            </>
          )}
        </div>
      )}

      {mode === "what-if" && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-xs font-semibold text-slate-400">Illustrative presets</p>
            {IMPACT_PRESETS.map((preset) => <button key={preset.id} type="button" className={buttonStyle} onClick={() => setFields(presetFields(preset))}>{preset.title}</button>)}
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            {SCENARIO_FIELDS.map((field) => (
              <label key={field.id} className="block text-sm text-slate-200">{field.title}
                <input type="number" className={inputStyle} min={0} max={field.max} step={field.step} value={fields[field.id]} onChange={(e) => setFields({ ...fields, [field.id]: e.target.value })} />
                <span className="mt-1 block text-[0.7rem] text-amber-200">{IMPACT_ASSUMPTION}</span>
              </label>
            ))}
          </div>
          {defaults && (
            <fieldset className="space-y-3 rounded-xl border border-white/10 p-3">
              <legend className="px-1 text-sm font-semibold text-white">Adjust financial assumptions</legend>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {keys.map((key) => {
                  const spec = IMPACT_INPUTS[key];
                  return (
                    <div key={key} className="min-w-0">
                      <label className="block text-sm text-slate-200">
                        {spec.label}{spec.unit === "PKR" ? " (PKR)" : " (0 to 1)"}
                        <input type="number" className={inputStyle} value={overrides[key] ?? defaults[key].value} min={0} max={spec.max} step={spec.step} onChange={(e) => setOverrides({ ...overrides, [key]: e.target.value })} />
                        <span className="mt-1 block text-[0.7rem] text-amber-200">{IMPACT_ASSUMPTION}</span>
                      </label>
                      <button type="button" className="mt-1 min-h-9 rounded text-xs text-cyan-200 hover:underline" disabled={overrides[key] === undefined} onClick={() => setOverrides((previous) => ({ ...previous, [key]: undefined }))} aria-label={`Reset ${spec.label} to default`}>Reset to default</button>
                    </div>
                  );
                })}
              </div>
              <button type="button" className={buttonStyle} onClick={() => { setOverrides({}); setFields(presetFields(IMPACT_PRESETS[1])); }}>
                <RotateCcw size={14} aria-hidden="true" /> Reset all inputs
              </button>
            </fieldset>
          )}
          {scenario && !scenario.ok && <p role="alert" className="text-sm text-red-200">{scenario.error.field}. {scenario.error.message}</p>}
          {scenario?.ok && (
            <>
              <p className="text-sm text-slate-300">Illustrative counts · {scenario.data.impact.counts.tp} true detections · {scenario.data.impact.counts.fp} false alarms · {scenario.data.impact.counts.fn} missed events</p>
              <Headline impact={scenario.data.impact} />
              <Sensitivity scenario={scenario.data} />
            </>
          )}
        </div>
      )}

      {mode === "simulated-session" && session?.ok && (
        <dl className="grid gap-3 sm:grid-cols-3">
          <div><dt className="text-sm text-slate-400">Recorded simulated allocations</dt><dd className="mt-1 text-lg font-semibold text-white">{session.data.allocationCount}</dd></div>
          <div><dt className="text-sm text-slate-400">Recorded simulated spend</dt><dd className="mt-1 text-lg font-semibold text-white">{fmtPkr(session.data.simulatedSpendPkr)}</dd></div>
          <div><dt className="text-sm text-slate-400">Assumed true detections to cover spend</dt><dd className="mt-1 text-lg font-semibold text-white">{session.data.breakEvenTrueDetections ?? "Unavailable"}</dd>{session.data.breakEvenReason && <p className="text-xs text-slate-400">{session.data.breakEvenReason}</p>}</div>
        </dl>
      )}
      {mode === "simulated-session" && session && !session.ok && <p role="alert" className="text-sm text-red-200">{session.error.message}</p>}
      {mode !== "measured" && defaultsError && <p role="alert" className="text-sm text-red-200">{defaultsError}</p>}
      {mode !== "measured" && !defaults && !defaultsError && <p role="status" className="text-sm text-slate-400">Loading assumptions…</p>}
      {assumptionsUsed && (
        <details className="rounded-xl border border-white/10 p-3">
          <summary className="cursor-pointer text-sm font-semibold text-slate-200">Assumptions used</summary>
          <dl className="mt-3 grid gap-3 sm:grid-cols-2">
            {Object.values(assumptionsUsed).map((a) => (
              <div key={a.label}>
                <dt className="text-xs text-slate-400">{a.label} · {a.flag}</dt>
                <dd className="text-sm text-white">{assumptionValue(a)} <span className="text-xs text-slate-400">{a.sourceNote}</span></dd>
              </div>
            ))}
          </dl>
        </details>
      )}
    </Glass>
  );
}
