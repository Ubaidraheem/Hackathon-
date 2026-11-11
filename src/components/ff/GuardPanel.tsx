"use client";

import { ShieldAlert, ShieldCheck, ShieldX } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "@/lib/api-client";
import type { GuardVerdict } from "@/lib/floodfund/guard";
import type { GuardCaseInfo, GuardCaseResult } from "@/lib/floodfund/types";
import { Glass, Pill } from "./ui";

export function GuardDetails({ guard }: { guard: GuardVerdict }) {
  const status = guard.status === "accepted"
    ? { text: "Accepted", tone: "ok", Icon: ShieldCheck } as const
    : guard.status === "low_confidence"
      ? { text: "Low confidence", tone: "warn", Icon: ShieldAlert } as const
      : { text: "Rejected", tone: "crit", Icon: ShieldX } as const;
  return (
    <div className="space-y-2">
      <Pill tone={status.tone} icon={<status.Icon size={14} aria-hidden="true" />}>{status.text}</Pill>
      {guard.reasons.length > 0 && (
        <ul className="space-y-1 text-xs leading-relaxed text-slate-300">
          {guard.reasons.map((reason) => (
            <li key={`${reason.code}-${reason.field}`} className="break-words">
              <code className="text-slate-100">{reason.code}</code> · {reason.field}. {reason.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function GuardPanel({ disabled, onRun }: { disabled: boolean; onRun: (caseId: string) => Promise<GuardCaseResult> }) {
  const [cases, setCases] = useState<GuardCaseInfo[]>([]);
  const [results, setResults] = useState<Record<string, GuardCaseResult>>({});
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    api.guardCases().then(
      (data) => { if (active) setCases(data.cases); },
      (err: unknown) => { if (active) setError(err instanceof Error ? err.message : "Guard tests could not be loaded."); },
    );
    return () => { active = false; };
  }, []);

  async function run(id: string) {
    setPending(id);
    setError(null);
    try {
      const result = await onRun(id);
      setResults((previous) => ({ ...previous, [id]: result }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "The guard test could not run.");
    } finally {
      setPending(null);
    }
  }

  return (
    <Glass className="p-5 sm:p-6" aria-labelledby="guard-title">
      <p className="ff-eyebrow">Demo · C04</p>
      <h2 id="guard-title" className="mt-1 text-lg font-semibold text-white">Guard test</h2>
      <p className="mt-1 text-sm text-slate-400">Synthetic invalid inputs for validation testing. Not real data.</p>
      {error && <p role="alert" className="mt-3 text-sm text-red-200">{error}</p>}
      {cases.length === 0 && !error && <p role="status" className="mt-3 text-sm text-slate-400">Loading guard tests…</p>}
      <ul className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {cases.map((item) => {
          const result = results[item.id];
          return (
            <li key={item.id} className="min-w-0 rounded-xl border border-white/10 bg-white/[0.03] p-3.5">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <h3 className="text-sm font-semibold text-white">{item.title}</h3>
                  <p className="mt-1 text-xs leading-relaxed text-slate-400">{item.description}</p>
                </div>
                <button type="button" disabled={disabled || pending !== null} aria-label={`Run ${item.title}`} onClick={() => void run(item.id)} className="min-h-11 rounded-lg border border-cyan-300/25 px-3 text-xs font-semibold text-cyan-100 transition hover:bg-cyan-300/10 disabled:opacity-50">
                  {pending === item.id ? "Running…" : "Run"}
                </button>
              </div>
              <div aria-live="polite">
                {result && (
                  <div className="mt-3 space-y-2 border-t border-white/10 pt-3">
                    <GuardDetails guard={result.guard} />
                    {result.decision.allocationId === null && result.budgetBeforePkr === result.budgetAfterPkr && (
                      <p className="text-xs text-slate-300">No allocation. Budget unchanged.</p>
                    )}
                    <p className="text-xs text-slate-400">Audit record #{result.audit.id}</p>
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </Glass>
  );
}
