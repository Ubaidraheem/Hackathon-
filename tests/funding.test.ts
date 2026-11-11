import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { db, pool } from "../src/db";
import { driftChecks, sessions } from "../src/db/schema";
import { buildLiveForecast } from "../src/lib/floodfund/forecast";
import { NotFoundError, buildDashboard, createSession, evaluateForecast, listAudit, resetSession } from "../src/lib/floodfund/funding";
import { SCENARIO_IDS, buildScenarioForecast, listScenarios } from "../src/lib/floodfund/scenarios";
import { runSchedulerTick } from "../src/lib/floodfund/scheduler";
import { HOUR_MS } from "../src/lib/floodfund/time";
import type { DataStatus, Forecast, SessionCreated, Dashboard } from "../src/lib/floodfund/types";
import { POST as createSessionRoute } from "../src/app/api/v1/demo/sessions/route";
import { GET as dashboardRoute } from "../src/app/api/v1/demo/sessions/[sessionId]/dashboard/route";
import { POST as evaluateLiveRoute } from "../src/app/api/v1/demo/sessions/[sessionId]/evaluate-live/route";
import { POST as scenarioRoute } from "../src/app/api/v1/demo/sessions/[sessionId]/scenarios/route";
import { POST as guardTestRoute } from "../src/app/api/v1/demo/sessions/[sessionId]/guard-test/route";
import { GET as guardCasesRoute } from "../src/app/api/v1/guard/cases/route";
import { GUARD_CASES, GUARD_CONTROL, buildGuardCaseForecast } from "../src/lib/floodfund/guardCases";
import type { GuardCaseResult } from "../src/lib/floodfund/types";
import { GET as sessionImpactRoute } from "../src/app/api/v1/demo/sessions/[sessionId]/impact/route";
import { POST as impactScenarioRoute } from "../src/app/api/v1/impact/scenario/route";
import { POST as driftTestRoute } from "../src/app/api/v1/demo/sessions/[sessionId]/drift-test/route";
import { GET as liveDriftRoute } from "../src/app/api/v1/drift/status/route";

/**
 * Funding engine tests against the real local PostgreSQL database (isolated
 * sessions, cleaned up afterwards). Weather providers are disabled: every
 * network call fails, so no test depends on live weather.
 */
const NOW = Date.parse("2026-11-10T16:49:34Z");
const created: string[] = [];

async function newSession(): Promise<string> {
  const id = await createSession();
  created.push(id);
  return id;
}

/** A hand-built "live" forecast fixture (never shown to users) to exercise the live rule deterministically. */
function liveFixture(totalMm: number, status: DataStatus, windowStartIso = "2026-11-10T17:00:00.000Z"): Forecast {
  const base = buildScenarioForecast("severe-storm", NOW);
  const start = Date.parse(windowStartIso);
  return {
    ...base,
    dataKind: "live",
    scenarioId: null,
    source: "test fixture",
    model: "test fixture",
    modelId: "fixture",
    status,
    statusReason: `fixture ${status}`,
    freshnessVerified: status === "fresh",
    modelRunAt: status === "unverified" ? null : "2026-11-10T06:00:00.000Z",
    windowStart: new Date(start).toISOString(),
    windowEnd: new Date(start + 24 * HOUR_MS).toISOString(),
    totalMm: status === "unavailable" || status === "invalid" ? null : totalMm,
    hourly: [],
  };
}

const scenario = (id: (typeof SCENARIO_IDS)[number]) => buildScenarioForecast(id, NOW);

const runGuard = (sessionId: string, caseId: unknown) => guardTestRoute(
  new Request("http://localhost/guard-test", { method: "POST", body: JSON.stringify({ caseId }) }),
  { params: Promise.resolve({ sessionId }) },
);

beforeAll(() => {
  vi.stubGlobal("fetch", vi.fn(async () => {
    throw new Error("network disabled in tests");
  }));
});

afterAll(async () => {
  if (created.length) await db.delete(sessions).where(inArray(sessions.id, created));
  vi.unstubAllGlobals();
  await pool.end();
});

describe("demo scenarios", () => {
  it("have 24 hourly values that add up to the stated total", () => {
    const expected = { calm: 40, "severe-storm": 96, "exact-threshold": 80, "stale-data": 96 } as const;
    expect(listScenarios().map((s) => s.id)).toEqual(["calm", "severe-storm", "exact-threshold", "stale-data"]);
    for (const id of SCENARIO_IDS) {
      const f = scenario(id);
      expect(f.dataKind).toBe("demo");
      expect(f.source).toMatch(/DEMO/);
      expect(f.hourly).toHaveLength(24);
      expect(f.totalMm).toBe(expected[id]);
      expect(f.hourly.reduce((a, h) => a + h.precipitationMm, 0)).toBeCloseTo(expected[id], 9);
      expect(f.status).toBe(id === "stale-data" ? "stale" : "fresh");
    }
  });

  it("calm: 40 mm, no allocation", async () => {
    const id = await newSession();
    const start = await buildDashboard(id);
    expect(start.mode).toBe("live");
    expect(start.budget.remainingPkr).toBe(2_000_000);
    expect(start.decision).toBeNull();

    expect((await evaluateForecast(id, scenario("calm"), { trigger: "scenario" })).status).toBe("below_threshold");
    const d = await buildDashboard(id);
    expect(d.mode).toBe("demo");
    expect(d.forecast.dataKind).toBe("demo");
    expect(d.decision?.status).toBe("below_threshold");
    expect(d.allocations).toHaveLength(0);
    expect(d.budget.remainingPkr).toBe(2_000_000);
  });

  it("severe storm: exactly one simulated PKR 500,000 allocation, even when repeated", async () => {
    const id = await newSession();
    expect((await evaluateForecast(id, scenario("severe-storm"), { trigger: "scenario" })).status).toBe("allocated");
    expect((await evaluateForecast(id, scenario("severe-storm"), { trigger: "scenario" })).status).toBe("already_allocated");
    const d = await buildDashboard(id);
    expect(d.allocations).toHaveLength(1);
    expect(d.allocations[0]).toMatchObject({ amountPkr: 500_000, simulated: true, eventId: "DEMO-SEVERE-STORM", forecastTotalMm: 96 });
    expect(d.budget).toMatchObject({ remainingPkr: 1_500_000, allocatedPkr: 500_000, allocationCount: 1, simulated: true });
    expect(Number.isInteger(d.budget.remainingPkr)).toBe(true);
    expect(d.audit.some((a) => a.type === "simulated_allocation" && /SIMULATED/.test(a.message))).toBe(true);
  });

  it("exactly 80 mm triggers the rule (>=)", async () => {
    const id = await newSession();
    expect((await evaluateForecast(id, scenario("exact-threshold"), { trigger: "scenario" })).status).toBe("allocated");
    expect((await buildDashboard(id)).budget.remainingPkr).toBe(1_500_000);
  });

  it("stale data: 96 mm cannot be evaluated and allocates nothing", async () => {
    const id = await newSession();
    expect((await evaluateForecast(id, scenario("stale-data"), { trigger: "scenario" })).status).toBe("cannot_evaluate");
    const d = await buildDashboard(id);
    expect(d.decision?.status).toBe("cannot_evaluate");
    expect(d.decision?.reason).toMatch(/stale/i);
    expect(d.allocations).toHaveLength(0);
    expect(d.budget.remainingPkr).toBe(2_000_000);
  });
});

describe("guard test API and transaction", () => {
  it.each([...GUARD_CASES, GUARD_CONTROL])("$id leaves allocation and budget untouched and appends an audit record", async (testCase) => {
    const id = await newSession();
    const start = await buildDashboard(id);
    const res = await runGuard(id, testCase.id);
    expect(res.status).toBe(200);
    const result: GuardCaseResult = await res.json();
    expect(result.guard.status).toBe(testCase.expectedStatus);
    expect(result.guard.reasons.map((r) => r.code)).toEqual(expect.arrayContaining(testCase.expectedReasonCodes));
    expect(result.decision).toMatchObject({ allocationId: null, eventId: null });
    expect(result.budgetAfterPkr).toBe(result.budgetBeforePkr);
    const end = await buildDashboard(id);
    expect(end.budget).toEqual(start.budget);
    expect(end.allocations).toHaveLength(0);
    expect(end.mode).toBe(start.mode);
    expect(end.decision).toBeNull();
    expect(await listAudit(id)).toContainEqual(result.audit);
    expect(result.audit.details).toMatchObject({ guard: result.guard, guardCaseId: testCase.id });
    for (const code of testCase.expectedReasonCodes) expect(result.audit.message).toContain(code);
  });

  it("audits eight concurrent guard failures and creates no allocations", async () => {
    const id = await newSession();
    const forecast = buildGuardCaseForecast(GUARD_CASES[4], NOW);
    const results = await Promise.all(Array.from({ length: 8 }, () => evaluateForecast(id, forecast, { trigger: "manual" })));
    expect(results.every((r) => r.status === "cannot_evaluate")).toBe(true);
    const dashboard = await buildDashboard(id);
    expect(dashboard.budget.remainingPkr).toBe(dashboard.budget.initialPkr);
    expect(dashboard.allocations).toHaveLength(0);
    expect(dashboard.audit.filter((row) => row.message.includes("FEATURE_OUT_OF_TRAINING_RANGE"))).toHaveLength(8);
  });

  it("lists five injections plus the control without writing and rejects unknown case IDs", async () => {
    const id = await newSession();
    const before = await listAudit(id);
    const list = guardCasesRoute();
    expect(list.status).toBe(200);
    expect((await list.json()).cases.map((item: { id: string }) => item.id)).toEqual([...GUARD_CASES, GUARD_CONTROL].map((item) => item.id));
    const bad = await runGuard(id, "unknown");
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: { code: "invalid_guard_case" } });
    expect((await runGuard("invalid-id", GUARD_CASES[0].id)).status).toBe(404);
    expect(await listAudit(id)).toEqual(before);
  });

  it("includes the additive verdict on a scenario response", async () => {
    const id = await newSession();
    const res = await scenarioRoute(
      new Request("http://localhost/scenarios", { method: "POST", body: JSON.stringify({ scenarioId: "calm" }) }),
      { params: Promise.resolve({ sessionId: id }) },
    );
    expect(await res.json()).toMatchObject({ guard: { status: "accepted" }, forecast: { guard: { status: "accepted" }, totalMm: 40 } });
  });
});

describe("C08 session drift", () => {
  const runDrift = (sessionId: string, caseId: string) => driftTestRoute(
    new Request("http://localhost/drift-test", { method: "POST", body: JSON.stringify({ caseId }) }),
    { params: Promise.resolve({ sessionId }) },
  );

  it("persists per-feature evidence and an audit entry without changing session state", async () => {
    const id = await newSession();
    const before = await buildDashboard(id);
    const response = await runDrift(id, "covariate-shift-heavier-rain");
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result).toMatchObject({
      verdict: "retrain_recommended", dataKind: "demo", budgetBeforePkr: before.budget.remainingPkr,
      budgetAfterPkr: before.budget.remainingPkr,
      audit: { type: "drift_test", details: { reasonCodes: expect.arrayContaining(["PSI_ABOVE_DRIFT", "KS_SIGNIFICANT"]) } },
    });
    expect(await db.select().from(driftChecks).where(eq(driftChecks.sessionId, id))).toMatchObject([{
      id: result.driftCheckId, caseId: "covariate-shift-heavier-rain", verdict: result.verdict,
      perFeatureResults: result.features, reasons: result.reasons,
    }]);
    await liveDriftRoute();
    const after = await buildDashboard(id);
    expect(after.audit).toEqual([result.audit, ...before.audit]);
    expect(after.budget).toEqual(before.budget);
    expect(after.mode).toBe(before.mode);
    expect(after.evaluations).toEqual(before.evaluations);
    expect(after.allocations).toEqual(before.allocations);
  });

  it("leaves a qualifying raw live AIFS allocation intact after a retraining recommendation", async () => {
    const id = await newSession();
    const result = await (await runDrift(id, "concept-drift-residual-bias")).json();
    expect(result.verdict).toBe("retrain_recommended");
    const start = Date.parse("2026-11-10T17:00:00Z");
    const forecast = buildLiveForecast({
      retrievedAtMs: NOW, pinned: true, pinProblem: null, grid: null,
      meta: { initMs: Date.parse("2026-11-10T06:00:00Z"), availableMs: null, stepSeconds: 21600 },
      series: {
        unit: "mm", timesUnix: Array.from({ length: 24 }, (_, i) => (start + (i + 1) * HOUR_MS) / 1000),
        values: Array<number>(24).fill(4),
      },
    }, NOW);
    expect(forecast).toMatchObject({ dataKind: "live", status: "fresh", totalMm: 96, guard: { status: "accepted" } });
    expect((await evaluateForecast(id, forecast, { trigger: "manual" })).status).toBe("allocated");
    const dashboard = await buildDashboard(id, { liveForecast: forecast });
    expect(dashboard.budget).toMatchObject({ remainingPkr: 1_500_000, allocationCount: 1 });
    expect(dashboard.allocations[0]).toMatchObject({ mode: "live", amountPkr: 500_000, forecastTotalMm: 96 });
  });
});

describe("C15 session impact", () => {
  it("reads actual simulated spend and leaves the budget and audit untouched after what-if requests", async () => {
    const sessionId = await newSession();
    await evaluateForecast(sessionId, scenario("severe-storm"), { trigger: "scenario" });
    const before = await buildDashboard(sessionId);
    const response = await sessionImpactRoute(
      new Request("http://localhost/impact"),
      { params: Promise.resolve({ sessionId }) },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      mode: "simulated-session", simulated: true, allocationCount: 1,
      simulatedSpendPkr: before.allocations.length * 500_000, breakEvenTrueDetections: 1,
    });
    const whatIf = await impactScenarioRoute(new Request("http://localhost/api/v1/impact/scenario", {
      method: "POST",
      body: JSON.stringify({ eventCount: 10, recall: 1, falseAlarmCount: 1, overrides: { damageRatio: 1 } }),
    }));
    expect(whatIf.status).toBe(200);
    const after = await buildDashboard(sessionId);
    expect(after.budget).toEqual(before.budget);
    expect(after.allocations).toEqual(before.allocations);
    expect(after.evaluations).toEqual(before.evaluations);
    expect(after.audit).toEqual(before.audit);
  });
});

describe("idempotency and concurrency", () => {
  it("concurrent requests create one allocation and deduct the budget once", async () => {
    const id = await newSession();
    const results = await Promise.all(Array.from({ length: 8 }, () => evaluateForecast(id, scenario("severe-storm"), { trigger: "scenario" })));
    expect(results.filter((r) => r.status === "allocated")).toHaveLength(1);
    expect(results.filter((r) => r.status === "already_allocated")).toHaveLength(7);
    const d = await buildDashboard(id);
    expect(d.allocations).toHaveLength(1);
    expect(d.budget.remainingPkr).toBe(1_500_000);
    expect(d.budget.initialPkr - d.budget.allocatedPkr).toBe(d.budget.remainingPkr);
  });

  it("the database rejects a duplicate session + policy + event allocation", async () => {
    const id = await newSession();
    await evaluateForecast(id, scenario("severe-storm"), { trigger: "scenario" });
    await expect(
      pool.query(
        `INSERT INTO ff_allocations (session_id, policy_id, event_id, amount_pkr, forecast_total_mm, mode, window_start, window_end)
         SELECT session_id, policy_id, event_id, amount_pkr, forecast_total_mm, mode, window_start, window_end FROM ff_allocations WHERE session_id = $1`,
        [id],
      ),
    ).rejects.toThrow(/ff_allocations_session_policy_event_key/);
  });

  it("stops at an insufficient simulated budget and never goes negative", async () => {
    const id = await newSession();
    const statuses: string[] = [];
    for (let day = 0; day < 5; day++) {
      const start = new Date(Date.parse("2026-11-10T17:00:00Z") + day * 48 * HOUR_MS).toISOString();
      statuses.push((await evaluateForecast(id, liveFixture(120, "fresh", start), { trigger: "manual" })).status);
    }
    expect(statuses).toEqual(["allocated", "allocated", "allocated", "allocated", "insufficient_budget"]);
    const d = await buildDashboard(id, { liveForecast: liveFixture(0, "fresh") });
    expect(d.budget.remainingPkr).toBe(0);
    expect(d.allocations).toHaveLength(4);
  });
});

describe("live rule", () => {
  it("stale, unverified, invalid or unavailable data can never trigger an allocation", async () => {
    const id = await newSession();
    for (const status of ["stale", "unverified", "invalid", "unavailable"] as const) {
      expect((await evaluateForecast(id, liveFixture(150, status), { trigger: "manual" })).status).toBe("cannot_evaluate");
    }
    const d = await buildDashboard(id, { liveForecast: liveFixture(150, "stale") });
    expect(d.allocations).toHaveLength(0);
    expect(d.budget.remainingPkr).toBe(2_000_000);
    expect(d.evaluations).toHaveLength(4);
  });

  it("uses a stable event ID across repeated and overlapping live checks", async () => {
    const id = await newSession();
    expect((await evaluateForecast(id, liveFixture(90, "fresh", "2026-11-10T23:00:00.000Z"), { trigger: "manual" })).status).toBe("allocated");
    expect((await evaluateForecast(id, liveFixture(92, "fresh", "2026-11-10T23:00:00.000Z"), { trigger: "manual" })).status).toBe("already_allocated");
    // One hour later the window starts on the next UTC day but still overlaps the allocated window.
    expect((await evaluateForecast(id, liveFixture(95, "fresh", "2026-11-11T00:00:00.000Z"), { trigger: "scheduler" })).status).toBe("already_allocated");
    const d = await buildDashboard(id, { liveForecast: liveFixture(95, "fresh") });
    expect(d.allocations).toHaveLength(1);
    expect(d.allocations[0].eventId).toBe("LIVE-KARACHI-20261110");
    expect(d.budget.remainingPkr).toBe(1_500_000);
  });

  it("scheduler checks are de-duplicated and never touch demo-mode sessions", async () => {
    const id = await newSession();
    const calm = liveFixture(3, "fresh");
    expect(await evaluateForecast(id, calm, { trigger: "scheduler", dedupe: true })).toEqual({ status: "below_threshold", recorded: true });
    expect(await evaluateForecast(id, calm, { trigger: "scheduler", dedupe: true })).toEqual({ status: "below_threshold", recorded: false });
    await evaluateForecast(id, scenario("calm"), { trigger: "scenario" });
    expect(await evaluateForecast(id, liveFixture(150, "fresh"), { trigger: "scheduler", dedupe: true })).toEqual({ status: "skipped", recorded: false });
    expect((await buildDashboard(id)).allocations).toHaveLength(0);
  });

  it("the automatic check records provider failure and never allocates on unavailable data", async () => {
    const before = await pool.query("SELECT * FROM ff_scheduler_state WHERE id = 1");
    try {
      const id = await newSession();
      const tick = await runSchedulerTick({ onlySessionIds: [id] }); // providers are down in tests
      expect(tick.checked).toBe(1);
      expect(tick.error).toMatch(/unavailable/i);
      const d = await buildDashboard(id);
      expect(d.evaluations[0]).toMatchObject({ trigger: "scheduler", status: "cannot_evaluate", dataStatus: "unavailable" });
      expect(d.allocations).toHaveLength(0);
      expect(d.budget.remainingPkr).toBe(2_000_000);
      expect(d.scheduler.lastRunAt).not.toBeNull();
      expect(d.scheduler.lastError).toMatch(/unavailable/i);
    } finally {
      // Put the real scheduler status back so a test run never changes what the app displays.
      await pool.query("DELETE FROM ff_scheduler_state WHERE id = 1");
      const r = before.rows[0];
      if (r) {
        await pool.query(
          "INSERT INTO ff_scheduler_state (id, last_run_at, last_success_at, last_error, last_error_at, sessions_checked) VALUES (1, $1, $2, $3, $4, $5)",
          [r.last_run_at, r.last_success_at, r.last_error, r.last_error_at, r.sessions_checked],
        );
      }
    }
  });
});

describe("sessions", () => {
  it("reset affects only that session and keeps the audit trail", async () => {
    const a = await newSession();
    const b = await newSession();
    await evaluateForecast(a, scenario("severe-storm"), { trigger: "scenario" });
    await evaluateForecast(b, scenario("severe-storm"), { trigger: "scenario" });
    await resetSession(a);
    const da = await buildDashboard(a, { liveForecast: liveFixture(0, "fresh") });
    const dbb = await buildDashboard(b);
    expect(da).toMatchObject({ mode: "live", scenarioId: null, decision: null });
    expect(da.budget.remainingPkr).toBe(2_000_000);
    expect(da.allocations).toHaveLength(0);
    expect(dbb.budget.remainingPkr).toBe(1_500_000);
    expect(dbb.allocations).toHaveLength(1);
    const audit = await listAudit(a);
    expect(audit[0].type).toBe("session_reset");
    expect(audit.map((r) => r.type)).toContain("simulated_allocation");
    // After a reset the same scenario can allocate again.
    expect((await evaluateForecast(a, scenario("severe-storm"), { trigger: "scenario" })).status).toBe("allocated");
  });

  it("GET-style dashboard reads never create allocations, evaluations or audit records", async () => {
    const id = await newSession();
    for (let i = 0; i < 3; i++) await buildDashboard(id, { liveForecast: liveFixture(150, "fresh") });
    const d = await buildDashboard(id, { liveForecast: liveFixture(150, "fresh") });
    expect(d.allocations).toHaveLength(0);
    expect(d.evaluations).toHaveLength(0);
    expect(d.decision).toBeNull();
    expect(d.audit.map((a) => a.type)).toEqual(["session_created"]);
    expect(d.budget.remainingPkr).toBe(2_000_000);
  });

  it("unknown sessions are rejected", async () => {
    await expect(buildDashboard("00000000-0000-4000-8000-000000000000")).rejects.toBeInstanceOf(NotFoundError);
    await expect(resetSession("00000000-0000-4000-8000-000000000000")).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("HTTP contract (route handlers)", () => {
  const ctx = (sessionId: string) => ({ params: Promise.resolve({ sessionId }) });
  const post = (body?: unknown) => new Request("http://test.local/", { method: "POST", body: body === undefined ? undefined : JSON.stringify(body), headers: { "content-type": "application/json" } });

  it("keeps the dashboard GET read-only and records a decision on the separate evaluate-live POST", async () => {
    const sessionId = await newSession();
    const read = async () => {
      const response = await dashboardRoute(new Request("http://test.local/dashboard"), ctx(sessionId));
      expect(response.status).toBe(200);
      return (await response.json()) as Dashboard;
    };
    const before = await read();
    expect(before.decision).toBeNull();
    expect(before.audit.map((record) => record.type)).toEqual(["session_created"]);

    const response = await evaluateLiveRoute(post(), ctx(sessionId));
    expect(response.status).toBe(200);
    const checked = (await response.json()) as Dashboard;
    expect(checked.decision).toMatchObject({ trigger: "manual", status: "cannot_evaluate" });
    expect(checked.audit.map((record) => record.type)).toEqual(["evaluation", "session_created"]);
    expect(checked.budget).toEqual(before.budget);

    const after = await read();
    expect(after.audit).toEqual(checked.audit);
    expect(after.evaluations).toEqual(checked.evaluations);
  });

  it("creates a session, shows provider failure honestly and runs a scenario", async () => {
    const res = await createSessionRoute();
    expect(res.status).toBe(201);
    const { sessionId, dashboard } = (await res.json()) as SessionCreated;
    created.push(sessionId);
    expect(dashboard.sessionId).toBe(sessionId);
    expect(dashboard.mode).toBe("live");
    expect(dashboard.budget.remainingPkr).toBe(2_000_000);
    // Providers are down in tests: the forecast must be "unavailable" with null values, not synthetic.
    expect(dashboard.forecast).toMatchObject({ dataKind: "live", status: "unavailable", totalMm: null, hourly: [] });

    const live = (await (await evaluateLiveRoute(post(), ctx(sessionId))).json()) as Dashboard;
    expect(live.decision?.status).toBe("cannot_evaluate");
    expect(live.allocations).toHaveLength(0);

    const bad = await scenarioRoute(post({ scenarioId: "tsunami" }), ctx(sessionId));
    expect(bad.status).toBe(400);
    expect((await bad.json()).error.code).toBe("invalid_scenario");

    const storm = (await (await scenarioRoute(post({ scenarioId: "severe-storm" }), ctx(sessionId))).json()) as Dashboard;
    expect(storm).toMatchObject({ mode: "demo", scenarioId: "severe-storm" });
    expect(storm.decision?.status).toBe("allocated");
    expect(storm.budget.remainingPkr).toBe(1_500_000);

    const before = (await (await dashboardRoute(new Request("http://test.local/"), ctx(sessionId))).json()) as Dashboard;
    const after = (await (await dashboardRoute(new Request("http://test.local/"), ctx(sessionId))).json()) as Dashboard;
    expect(after.allocations).toHaveLength(1);
    expect(after.audit.length).toBe(before.audit.length);
  });

  it("returns 404 JSON for unknown or malformed session IDs", async () => {
    for (const id of ["not-a-uuid", "00000000-0000-4000-8000-000000000000"]) {
      const res = await dashboardRoute(new Request("http://test.local/"), ctx(id));
      expect(res.status).toBe(404);
      expect((await res.json()).error.code).toBe("session_not_found");
    }
  });
});
