"use client";

import { Activity, CircleCheck, Clock3, TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { api } from "@/lib/api-client";
import type { DriftFeatureResult, DriftResult, DriftVerdict } from "@/lib/floodfund/drift";
import type { LiveDriftStatus } from "@/lib/floodfund/drift-monitor";
import type { DriftCaseResult } from "@/lib/floodfund/drift-store";
import type { DriftCaseInfo } from "@/lib/floodfund/driftCases";
import { Glass, Pill } from "./ui";

const verdicts = {
  stable: { text: "Stable", tone: "ok", Icon: CircleCheck },
  warning: { text: "Warning", tone: "warn", Icon: TriangleAlert },
  retrain_recommended: { text: "Retrain recommended", tone: "crit", Icon: Activity },
  insufficient_data: { text: "Insufficient data", tone: "muted", Icon: Clock3 },
} as const;
const labels: Record<string, string> = {
  aifs_total_24h_mm: "AIFS total (mm)", aifs_max_hourly_mm: "Peak hour (mm)", aifs_wet_hours: "Wet hours",
  aifs_max_6h_mm: "Peak 6 h block (mm)", latitude: "Latitude", longitude: "Longitude",
  doy_sin: "Day-of-year sine", doy_cos: "Day-of-year cosine",
};
const featureLabel = (name: string) => labels[name] ?? name;
const metric = (v: number | null) => v === null ? "—" : v === 0 ? "0" : v < 0.001 && v > 0 ? v.toExponential(2) : v.toFixed(3);
const buttonClass = "inline-flex min-h-11 items-center justify-center rounded-lg border border-cyan-300/25 px-3 text-xs font-semibold text-cyan-100 hover:bg-cyan-300/10 disabled:opacity-50";

function Badge({ verdict }: { verdict: DriftVerdict }) {
  const { Icon, tone, text } = verdicts[verdict];
  return <Pill tone={tone} icon={<Icon size={14} aria-hidden="true" />}>{text}</Pill>;
}

function Histogram({ feature }: { feature: DriftFeatureResult }) {
  const format = (v: number) => v.toLocaleString("en", { maximumSignificantDigits: 5 });
  const data = feature.histogram.map(({ lower, upper, referenceCount, currentCount }) => ({
    bin: lower === null ? `≤ ${format(upper!)}` : upper === null ? `> ${format(lower)}` : `${format(lower)}–${format(upper)}`,
    Reference: 100 * referenceCount / feature.referenceCount,
    Current: 100 * currentCount / feature.currentCount,
  }));
  if (!data.length) return <p className="text-xs text-slate-400">No histogram for this sample size.</p>;
  return (
    <figure className="min-w-0 rounded-xl border border-white/10 p-3">
      <figcaption className="text-xs font-medium text-slate-300">{featureLabel(feature.feature)} · share of each sample by reference bin</figcaption>
      <div className="mt-2 h-48">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} accessibilityLayer>
            <CartesianGrid vertical={false} stroke="rgba(148,197,255,0.12)" />
            <XAxis dataKey="bin" tick={{ fill: "#a6b8cd", fontSize: 9 }} />
            <YAxis tickFormatter={(v) => `${v}%`} width={45} tick={{ fill: "#a6b8cd", fontSize: 10 }} />
            <Tooltip formatter={(v) => `${Number(v).toFixed(1)}%`} contentStyle={{ background: "#0a1830", borderColor: "#334155" }} />
            <Legend />
            <Bar dataKey="Reference" fill="#67e8f9" isAnimationActive={false} />
            <Bar dataKey="Current" fill="#a78bfa" isAnimationActive={false} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </figure>
  );
}

function DriftDetails({ result }: { result: DriftResult }) {
  const [selected, setSelected] = useState(() => result.features.find((f) => f.status === "drift" || f.status === "seasonal" || f.status === "warning")?.feature ?? result.features[0]?.feature ?? "");
  const active = result.features.find((f) => f.feature === selected) ?? result.features[0];
  const residuals = result.residuals;
  return (
    <div className="space-y-3">
      <p className="text-xs text-slate-400">Minimum {result.minSamples} values per window. Feature KS significance uses Bonferroni-adjusted p &lt; {result.ksAlphaPerFeature.toPrecision(3)}.</p>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs">
          <caption className="sr-only">Drift statistics per feature</caption>
          <thead className="text-slate-400">
            <tr>{["Feature", "Ref / current", "PSI", "KS D", "KS p-value", "Status"].map((v) => <th key={v} scope="col" className="whitespace-nowrap p-2">{v}</th>)}</tr>
          </thead>
          <tbody>
            {result.features.map((f) => (
              <tr className="border-t border-white/10 text-slate-200" key={f.feature}>
                <th scope="row" className="whitespace-nowrap p-2">{featureLabel(f.feature)}</th>
                <td className="p-2">{f.referenceCount} / {f.currentCount}</td>
                <td className="p-2">{metric(f.psi)}</td><td className="p-2">{metric(f.ksD)}</td><td className="p-2">{metric(f.ksPValue)}</td>
                <td className="whitespace-nowrap p-2">{f.status.replaceAll("_", " ")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {active && (
        <>
          <label className="block text-xs text-slate-300">
            Histogram feature
            <select value={active.feature} onChange={(e) => setSelected(e.target.value)} className="ml-2 min-h-10 rounded-lg border border-white/15 bg-[#071226] px-2 text-sm text-white">
              {result.features.map((f) => <option key={f.feature} value={f.feature}>{featureLabel(f.feature)}</option>)}
            </select>
          </label>
          <Histogram feature={active} />
        </>
      )}
      <p className="text-xs text-slate-300">
        <strong>Residual check</strong> · {residuals.status.replaceAll("_", " ")} · {residuals.referenceCount} reference / {residuals.currentCount} observed current residuals
        {residuals.meanShiftCi95Mm && <> · signed mean shift {metric(residuals.meanShiftMm)} mm · approximate 95% CI [{residuals.meanShiftCi95Mm.map(metric).join(", ")}] mm · KS p {metric(residuals.ksPValue)}</>}
      </p>
      {result.reasons.length > 0 && (
        <details open className="text-xs text-slate-300">
          <summary className="cursor-pointer font-medium">Reason codes ({result.reasons.length})</summary>
          <ul className="mt-2 space-y-1.5">
            {result.reasons.map((r) => <li key={`${r.field}-${r.code}`}><code className="break-all text-slate-100">{r.code}</code> · {featureLabel(r.field)}. {r.message}</li>)}
          </ul>
        </details>
      )}
    </div>
  );
}

export default function DriftPanel({ disabled, onRun, live, liveError, onRefresh }: {
  disabled: boolean;
  onRun: (id: string) => Promise<DriftCaseResult>;
  live: LiveDriftStatus | null;
  liveError: string | null;
  onRefresh: () => void;
}) {
  const [cases, setCases] = useState<DriftCaseInfo[]>([]);
  const [result, setResult] = useState<DriftCaseResult | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    api.driftCases().then(
      (data) => { if (active) setCases(data.cases); },
      (err: unknown) => { if (active) setError(err instanceof Error ? err.message : "The drift cases could not be loaded."); },
    );
    return () => { active = false; };
  }, []);

  async function run(id: string) {
    setPending(id);
    setError(null);
    try {
      setResult(await onRun(id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "The drift test failed.");
    } finally {
      setPending(null);
    }
  }

  return (
    <Glass id="drift" className="min-w-0 space-y-4 p-5 sm:p-6" aria-labelledby="drift-title">
      <div>
        <p className="ff-eyebrow">C08</p>
        <h2 id="drift-title" className="mt-1 text-lg font-semibold text-white">Concept drift detection</h2>
        <p className="mt-1 text-sm text-slate-300">Drift detection compares distributions. It does not prove the model is wrong and it never changes the funding rule.</p>
      </div>
      <div className="rounded-xl border border-white/10 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-white">Live team-model monitoring</h3>
          <button type="button" className={buttonClass} onClick={onRefresh}>Refresh live status</button>
        </div>
        <p className="mt-2 text-xs text-slate-400">{liveError ?? (live?.status === "available" ? `${live.sampleCount} archived Karachi days in the last ${live.lookbackDays} UTC days.` : live?.reason ?? "Loading live status…")}</p>
        {live && <p className="mt-1 text-xs text-slate-400">{live.observationNote}</p>}
        {live?.status === "available" && (
          <details className="mt-2">
            <summary className="cursor-pointer text-sm text-slate-300">Live statistics · <Badge verdict={live.result.verdict} /></summary>
            <div className="mt-3"><DriftDetails key={`${live.sampleCount}-${live.result.verdict}`} result={live.result} /></div>
          </details>
        )}
      </div>
      <h3 className="text-sm font-semibold text-white">DEMO / SYNTHETIC cases</h3>
      {error && <p role="alert" className="text-sm text-red-200">{error}</p>}
      {!cases.length && !error && <p role="status" className="text-xs text-slate-400">Loading demo cases…</p>}
      <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {cases.map((item) => (
          <li key={item.id} className="flex min-w-0 items-start justify-between gap-2 rounded-xl border border-white/10 p-3">
            <div><p className="text-sm font-semibold text-white">{item.title}</p><p className="mt-1 text-xs text-slate-400">{item.description}</p></div>
            <button type="button" className={buttonClass} disabled={disabled || pending !== null} aria-label={`Run ${item.title}`} onClick={() => void run(item.id)}>
              {pending === item.id ? "Running…" : "Run"}
            </button>
          </li>
        ))}
      </ul>
      {result && (
        <div className="space-y-3 rounded-xl border border-white/10 p-3">
          <div className="flex flex-wrap items-center gap-2" role="status">
            <h3 className="text-sm font-semibold text-white">{result.testCase.title} · DEMO / SYNTHETIC</h3>
            <Badge verdict={result.verdict} />
          </div>
          <p className="text-xs text-slate-300">{result.budgetBeforePkr === result.budgetAfterPkr ? "Budget unchanged." : ""} Audit record #{result.audit.id}.</p>
          <DriftDetails key={result.driftCheckId} result={result} />
        </div>
      )}
    </Glass>
  );
}
