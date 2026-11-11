# FloodFund Karachi

FloodFund Karachi is a hackathon dashboard for **simulated** municipal preparedness funding.
It fetches a real ECMWF AIFS rainfall forecast for Karachi, checks the next 24 complete hours,
and explains whether the session would allocate **PKR 500,000** from its simulated budget.
The map displays NASA satellite rainfall observations for context.

- **Live control room** shows the forecast, source and freshness, hourly breakdown, map,
  simulated funding decision, budget, decision timeline, and audit trail.
- **Demo scenarios** let you rehearse a calm day, a storm, the exact threshold, and stale data.
- **C04 Guard test** demonstrates how malformed and out-of-range inputs are rejected or flagged
  before funding. The panel shows reason codes and the audit record for each test.
- **C15 Boardroom impact** translates detection and false-alarm counts into assumption-based PKR
  calculations. It includes measured, what-if, and session modes, a sensitivity grid, and Markdown export.
- **C08 Concept drift detection** compares team-model input and residual distributions, shows six
  synthetic demos, and records their results in a session audit. The Challenge scoreboard summarizes
  the implementation, evidence, and open gaps for C04, C15, and C08.
- **Model comparison** compares archived raw AIFS and two team post-processors against the same
  fixed UTC day when the required artifacts are available.

> The 80 mm threshold is an example, not a validated flood warning. Heavy rainfall does not guarantee
> flooding. All funding is simulated: no bank, wallet, insurer or payment gateway is connected.

## Contents

- [Run it](#run-it)
- [Mission fit](#mission-fit-green-fintech-and-climate-adaptation)
- [Verification and reproducibility](#verification-and-reproducibility)
- [Dashboard walkthrough](#dashboard-walkthrough)
- [Architecture and source files](#architecture-and-source-files)
- [Data sources](#data-sources)
- [Configuration](#configuration)
- [API reference](#api-reference)
- [Forecast time handling](#forecast-time-handling) and [simulated funding](#the-simulated-funding-rule)
- [C04 guard](#out-of-bounds--hallucination-guard-c04) and [C15 financial impact](#net-financial-impact-model-c15)
- [C08 concept drift detection](#concept-drift-detection-c08)
- [Models and benchmark](#models)
- [Tests](#tests), [troubleshooting](#troubleshooting), and [deployment](#deploying-with-persistent-storage)
- Judge materials: [Seven-minute demo](docs/DEMO_SCRIPT.md), [Q&A](docs/QA_PREP.md), [Challenge evidence](docs/CHALLENGES.md), [Backup checklist](docs/BACKUP_PLAN.md)

## Mission fit: Green FinTech and climate adaptation

FloodFund is designed around a municipal disaster team's decision about whether to release pre-agreed preparedness funds before heavy monsoon rainfall in the coastal megacity of Karachi. Climate adaptation finance needs a way to act before extreme rainfall, especially where the team must balance preparedness spending against false alarms. The prototype applies a parametric-style rainfall trigger to illustrate how a predefined rule could reduce decision delays and leave an auditable explanation. All funding is simulated, and the project measures no avoided loss, real savings, or environmental benefit.

ECMWF's AIFS supplies the AI weather forecast, and only its validated raw output can drive the live funding rule. The team's Random Forest and neural network are fixed-day post-processors for comparison. Guard checks can block invalid or flagged forecasts, while the drift monitor can flag changes in team-model inputs or errors for review. The prior benchmark record covers one season and reports that no model detected the sole ≥ 80 mm reference exceedance, but this checkout lacks the original artifacts to reproduce it. The threshold is a demonstration value, and the prototype has no alerts or authentication and provides no flood model or basis for real decisions.

A municipal pilot would need local flood records to validate thresholds, asset and loss data to replace the financial assumptions, authentication, and a production scheduler. Heat and drought could use a similar workflow after defining hazard-specific inputs and rules. Neither extension is implemented.

## Architecture and source files

Next.js App Router serves the landing page, dashboard, and TypeScript API from one origin.
The dashboard calls relative `/api/v1` endpoints. The browser stores the demo session ID
locally so a reload can recover the same budget and audit history. A new session starts
in live mode with its own simulated budget. While the dashboard is open, it refreshes the
snapshot so scheduled decisions can appear without a manual check.

1. **Forecast.** The server reads model-run metadata, asks Open-Meteo for that specific AIFS
   run, selects the next 24 hourly intervals, and validates the values with C04.
2. **Decision.** Manual checks, the live scheduler, and demo scenarios call the funding
   engine. The engine checks validation, freshness, policy, threshold, and budget before
   recording an allocation and audit entries in PostgreSQL.
3. **Context.** NASA GIBS tiles and the historical model comparison appear alongside the
   forecast. The funding engine uses the validated live AIFS forecast or an explicitly
   selected demo scenario.
4. **Impact.** C15 reads saved test counts or a session's simulated spending. The What-if
   calculator also runs in the browser so inputs update instantly. Its standalone API
   uses the same calculation and does not write session data.
5. **Drift.** C08 reuses completed archived comparisons and checks their features against
   a trusted training reference. Manual demos write a drift check and an audit entry in one transaction.

| To revise | Start here |
| --- | --- |
| Landing page or control room | [Landing page](src/app/page.tsx), [ControlRoom](src/components/ff/ControlRoom.tsx), [dashboard cards](src/components/ff/panels.tsx), [global styles](src/app/globals.css) |
| Map and satellite rainfall | [MapPanel](src/components/ff/MapPanel.tsx), [LeafletMap](src/components/ff/LeafletMap.tsx), [satellite provider](src/lib/floodfund/satellite.ts) |
| Forecast source, time window, and freshness | [Forecast provider](src/lib/floodfund/forecast.ts), [UTC window helpers](src/lib/floodfund/time.ts) |
| Funding rule, audit, and scheduler | [Funding engine](src/lib/floodfund/funding.ts), [scheduler](src/lib/floodfund/scheduler.ts), [demo scenarios](src/lib/floodfund/scenarios.ts) |
| C04 validation and demo cases | [Guard checks](src/lib/floodfund/guard.ts), [synthetic cases](src/lib/floodfund/guardCases.ts), [Guard test panel](src/components/ff/GuardPanel.tsx) |
| C15 assumptions, formulas, and export | [Impact calculator](src/lib/floodfund/impact.ts), [benchmark reader](src/lib/floodfund/impact-data.ts), [Boardroom panel](src/components/ff/BoardroomImpact.tsx) |
| C08 statistics, demo and monitoring | [Drift statistics](src/lib/floodfund/drift.ts), [demo cases](src/lib/floodfund/driftCases.ts), [live monitoring](src/lib/floodfund/drift-monitor.ts), [audit writer](src/lib/floodfund/drift-store.ts), [Drift panel](src/components/ff/DriftPanel.tsx) |
| Historical model comparison | [Model registry and comparison](src/lib/floodfund/models.ts), [JSON model runtime](src/lib/floodfund/ml-runtime.ts), [Model Comparison panel](src/components/ff/ModelComparison.tsx) |
| API contract and defaults | [Route handlers](src/app/api/v1), [shared types](src/lib/floodfund/types.ts), [browser client](src/lib/api-client.ts), [app configuration](src/lib/config.ts) |
| Storage and schema bootstrap | [Drizzle schema](src/db/schema.ts), [schema bootstrap](src/db/ensure.ts) |

The main database tables are `ff_sessions` for session and budget state, `ff_allocations`
for simulated disbursements, `ff_evaluations` for funding decisions, `ff_audit` for
append-only explanations, `ff_drift_checks` for manual drift results, and `ff_scheduler_state`
for timer health. When adding a schema
change, account for both new databases and existing deployments. The bootstrap's
`CREATE TABLE IF NOT EXISTS` statements do not migrate existing table columns.

The Guard Test, Drift, and Boardroom Impact panels use distinct React keys scoped to the session.
Their local UI state resets when the dashboard switches to a different session.

## Important: stack differences from the original brief

The brief asked for FastAPI + SQLite + a Vite/React Router frontend. This project was built on a hosting
platform that runs **Next.js (App Router) + PostgreSQL** only, so the running application is:

| Brief | Delivered | Notes |
| --- | --- | --- |
| FastAPI + Uvicorn backend | **Next.js route handlers (TypeScript)** under `src/app/api/v1` | Same `/api/v1` endpoints and camelCase contract. There is **no FastAPI app** and therefore no Swagger `/docs` page; the endpoint list is below and the contract is `src/lib/floodfund/types.ts`. |
| SQLAlchemy + SQLite | **Drizzle ORM + PostgreSQL** | Same data model, uniqueness constraint and atomic transaction. |
| Vite + React Router | **Next.js pages** `/` and `/dashboard` | React, TypeScript, Tailwind, Framer Motion, Lucide, Recharts, React Leaflet are used as requested. No Vite proxy is needed: UI and API share one origin. |
| `backend/app/config.py` + `backend/.env` | `src/lib/config.ts` + `.env` for the web service; `backend/app/config.py` + `backend/.env` for the Python training pipeline | Two config centres, one per runtime. |
| Pytest for everything | **Vitest** for the API/funding engine, **Pytest** for the training pipeline | |
| scikit-learn models, joblib | **As requested** in the original Python pipeline | The web runtime consumes JSON exports of the fitted models. The parity test checks them against the saved Python predictions when the artifacts are available. |

This checkout contains the Next.js application and Vitest suite. The Python training source,
dataset and saved artifacts described below are absent from this checkout. The benchmark section
records the earlier run documented by the project. To reproduce it or enable the team models,
restore the original `backend/` tree or supply the original trusted artifacts.

---

## What is live and what is simulated

| Thing | Status | Source |
| --- | --- | --- |
| 24 h rainfall forecast | **Live, real** | ECMWF AIFS Single 0.25° via Open-Meteo |
| Forecast freshness | **Verified** | Open-Meteo model metadata + Single Runs API (`run=`) |
| Satellite rainfall layer | **Live, real** | NASA GIBS, GPM IMERG daily precipitation rate |
| Base map | Live | OpenStreetMap tiles via Leaflet |
| Model benchmark | **Prior benchmark figures preserved below, artifacts absent here** | The earlier project record describes archived AIFS runs compared with NASA POWER IMERG |
| Funding, budget, allocations | **Simulated** | Rows in this app's database |
| Demo scenarios (calm, severe-storm, exact-threshold, stale-data) | **Synthetic, labelled DEMO** | Deterministic values in `src/lib/floodfund/scenarios.ts` |
| C04 guard tests | **Synthetic, labelled DEMO / SYNTHETIC** | Five invalid or unusual inputs and one dry control in `src/lib/floodfund/guardCases.ts` |
| C15 Boardroom impact | **Assumption-based calculations and simulated spending** | Saved benchmark counts when available, illustrative what-if inputs, or PostgreSQL allocation records |
| C08 drift demos | **Synthetic, labelled DEMO / SYNTHETIC** | Fixed example feature and residual distributions |
| C08 live drift monitoring | **Real only with a trusted reference and enough archived samples** | Completed Karachi AIFS comparisons and, for residuals, matched NASA POWER IMERG observations |
| Landing-page globe | Decorative illustration | Not satellite data (and labelled as such) |

Live mode uses provider data only. If a pinned run cannot be fetched, the app can show the
provider's stitched forecast as `unverified`. When no forecast data is available, the UI
shows `unavailable` with a `null` total.

## Data sources

- **Open-Meteo / ECMWF AIFS** - live: `https://api.open-meteo.com/v1/ecmwf`. AIFS Single has a
  0.25° grid and 6-hourly native time steps. Open-Meteo interpolates output to hourly values and
  defines the hourly `precipitation` field as a total for the preceding hour. Pinned and archived runs:
  `https://single-runs-api.open-meteo.com/v1/forecast` (`models=ecmwf_aifs025_single`, `run=YYYY-MM-DDTHH:MM`);
  run metadata: `https://api.open-meteo.com/data/ecmwf_aifs025_single/static/meta.json`.
  [ECMWF forecast API](https://open-meteo.com/en/docs/ecmwf-api) · [Single Runs API](https://open-meteo.com/en/docs/single-runs-api)
- **NASA POWER** - `https://power.larc.nasa.gov/api/temporal/daily/point` with `parameters=IMERG_PRECTOT`,
  `community=SB`, `time-standard=UTC`. This is a UTC daily total in mm. NASA currently lists about
  14 hours of latency for the IMERG Late Run and about 3.5 months for Final Run. Recent values can
  be provisional, missing, or later revised. The app rejects the provider's fill value, with
  `-999` as its default sentinel. [NASA POWER meteorology sources](https://power.larc.nasa.gov/docs/methodology/data/sources_meteorology/)
- **NASA GIBS** - WMTS tiles for layer `IMERG_Precipitation_Rate` (`GoogleMapsCompatible_Level6`, native zoom ≤ 6).
  The observation date comes from the GIBS "Domains" metadata and is confirmed by loading a real tile.
  This is a daily rate imagery layer. The numeric daily total used in model comparison comes
  from NASA POWER. [NASA GIBS layer metadata](https://gibs.earthdata.nasa.gov/layer-metadata/v1.0/IMERG_Precipitation_Rate.json)
- **OpenStreetMap** - standard raster tiles served from `https://tile.openstreetmap.org/{z}/{x}/{y}.png`
  with visible attribution. [OSMF tile usage policy](https://operations.osmfoundation.org/policies/tiles/)

The configured feeds use public endpoints without API keys. Open-Meteo limits the
free API to non-commercial use and requires attribution. OpenStreetMap raster
tiles have a separate usage policy. Review both before deploying. [Open-Meteo terms](https://open-meteo.com/en/terms)
The current map uses Leaflet, OpenStreetMap, and NASA GIBS. OSIRIS weather overlays
were discussed as a future option and are not integrated in this checkout.

## Configuration

Application settings are in [src/lib/config.ts](src/lib/config.ts). The PostgreSQL
client reads `DATABASE_URL` from the process environment. Next.js loads the root
`.env` for local development. See [.env.example](.env.example) for a starting point.

| Variable | Default | Meaning |
| --- | --- | --- |
| `APP_ENV` | `development` | Environment label |
| `DATABASE_URL` | - | PostgreSQL connection string (required) |
| `CORS_ORIGINS` | empty | Extra origins allowed to call `/api/v1` (same-origin always works) |
| `FORECAST_CACHE_SECONDS` | `300` | Short cache for the provider payload |
| `SATELLITE_CACHE_SECONDS` | `1800` | Cache lifetime for available satellite layer metadata |
| `MODEL_MAX_RUN_AGE_HOURS` | `18` | Older runs are *stale* and cannot trigger funding |
| `LIVE_SCHEDULER_ENABLED` | `true` | Automatic live checks |
| `LIVE_REFRESH_MINUTES` | `15` | Scheduler interval |
| `SESSION_ACTIVE_HOURS` | `24` | Recency cutoff for scheduled checks of live sessions |
| `HTTP_TIMEOUT_MS` | `10000` | Provider request timeout |
| `HTTP_MAX_RETRIES` | `1` | Additional provider request attempts on retryable failures |
| `MODEL_ARTIFACTS_DIR` | `backend/artifacts` | Trusted local directory for model exports, benchmark, feature envelope, and drift reference |
| `POLICY_ACTIVE` | `true` | Enables simulated allocations |
| `POLICY_THRESHOLD_MM` | `80` | Live and demo funding threshold. C15 measured comparison still requires the saved 80 mm benchmark. |
| `POLICY_ALLOCATION_PKR` | `500000` | Simulated allocation per qualifying event and baseline cost for C15 |
| `POLICY_INITIAL_BUDGET_PKR` | `2000000` | Initial simulated budget per session |
| `GUARD_ENABLED` | `true` | Enables service-area checks, engineering caps and training-envelope checks. Finite-number, global coordinate, timestamp and series-integrity checks still apply when disabled. |
| `GUARD_MAX_HOURLY_MM` | `150` | Reject above this hourly total. |
| `GUARD_MAX_24H_MM` | `1000` | Reject above this 24-hour total. |
| `GUARD_SOFT_HOURLY_MM` | `100` | Flag hourly totals above this value as low confidence if they do not exceed the hard cap. |
| `GUARD_SOFT_24H_MM` | `500` | Flag 24-hour totals above this value as low confidence if they do not exceed the hard cap. |
| `GUARD_COORD_BOUNDS` | `23,37,60,78` | Inclusive service bounds in south, north, west, east order. |
| `GUARD_SUM_TOLERANCE_MM` | `0.05` | Maximum difference between a supplied total and the sum of 24 hourly values. |
| `IMPACT_PORTFOLIO_ASSET_VALUE_PKR` | `5000000000` | ASSUMPTION - replace with municipal data. Illustrative portfolio value in PKR. |
| `IMPACT_EXPOSED_FRACTION_PER_EVENT` | `0.02` | ASSUMPTION - replace with municipal data. Share of portfolio exposed in one event. |
| `IMPACT_DAMAGE_RATIO` | `0.15` | ASSUMPTION - replace with municipal data. Fraction of exposed assets damaged without preparedness. |
| `IMPACT_MITIGATION_EFFECTIVENESS` | `0.30` | ASSUMPTION - replace with municipal data. Fraction of damage avoided with timely preparedness. |
| `IMPACT_FALSE_ALARM_EXTRA_COST_PKR` | `0` | ASSUMPTION - replace with municipal data. Extra false-alarm operational cost above the simulated allocation. |
| `DRIFT_ENABLED` | `true` | Enables real-data monitoring and collection of completed comparison samples. Synthetic demos and stateless evaluations are available independently. |
| `DRIFT_PSI_WARN` | `0.10` | Lower edge of the PSI warning band. |
| `DRIFT_PSI_ALERT` | `0.25` | PSI must exceed this value to count as feature drift. |
| `DRIFT_KS_ALPHA` | `0.01` | KS significance level before adjustment across the feature family. |
| `DRIFT_MIN_SAMPLES` | `30` | Minimum samples per side for a verdict. The real window contains at most 90 distinct Karachi dates. |
| `DRIFT_BINS` | `10` | Requested reference quantile bins, clamped to 2–50. Ties can reduce the realized bin count. |
| `DRIFT_RETRAIN_FEATURE_COUNT` | `3` | Number of non-seasonal features that must exceed the PSI alert level and pass the KS significance check to recommend retraining. |

**Training pipeline:** `backend/app/config.py` (pydantic-settings) loads `backend/.env` through an absolute
path, so it works from any working directory. See `backend/.env.example`.

**Credentials:** The weather providers used here require no API keys. PostgreSQL needs a valid
`DATABASE_URL`, which can contain a password. Set it privately in the git-ignored `.env` file or your
hosting platform's secret settings. Anyone with filesystem access can read the local `.env`.

## Run it

Use Node.js 24, npm, and a reachable UTF-8 PostgreSQL database. The local
verification used Node.js 24.21.0. The installed Next.js package declares Node.js
20.9 or later, and the installed Vitest package declares `^22.12.0 || ^24.0.0 || >=26.0.0`. UTF-8
allows the audit trail to store Unicode reason text. Use a database role that can
read and write the FloodFund tables and run the schema bootstrap, which issues
`CREATE TABLE IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS`.

From the repository root on Windows PowerShell:

```powershell
npm install
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
# Set DATABASE_URL in .env to your PostgreSQL connection string.
npm run dev
```

On macOS or Linux:

```bash
npm install
test -f .env || cp .env.example .env
# Set DATABASE_URL in .env to your PostgreSQL connection string.
npm run dev
```

- [Landing page](http://localhost:3000/)
- [Control room](http://localhost:3000/dashboard)
- [Storm demo](http://localhost:3000/dashboard?scenario=severe-storm)
- [API health](http://localhost:3000/api/v1/health)

For a production build, run `npm run build` and then `npm run start`. Use the URL
printed by Next.js if port 3000 is already occupied. The app can initialize its
schema through the connection in `DATABASE_URL`. Check which database any local
Drizzle CLI config targets before running schema commands. [drizzle.config.ts](drizzle.config.ts)
loads the connection from the environment, with the local `.env` as a fallback.

## Verification and reproducibility

The following local smoke checks were recorded on **11 November 2026** on both
development and production servers. The production rehearsal used a separate
PostgreSQL database with the scheduler disabled. Provider timestamps and
statuses are snapshots.

| Check | Observed result |
| --- | --- |
| `GET /dashboard` and `GET /api/v1/health` | HTTP 200. The health response reported `database: "ok"`. |
| `GET /api/v1/areas/karachi/forecast` | `fresh`, with 24 hourly values in mm from the pinned 06:00 UTC AIFS run. |
| `GET /api/v1/areas/karachi/satellite` | `available`. NASA GIBS returned a valid test tile for the 10 November UTC observation day. |
| `GET /api/v1/guard/cases` and `GET /api/v1/drift/cases` | Six cases each. C04 includes the dry control. |
| Archived model comparison for 9 November UTC | HTTP 200, raw AIFS comparison available. The NASA POWER reference was null because no usable IMERG value was returned for that day. |
| Session creation, Severe storm twice, and reset | Session creation HTTP 201. Scenario and reset requests HTTP 200. Simulated balance PKR 2,000,000 → 1,500,000 → 1,500,000 → 2,000,000. The repeat returned `already_allocated` and the reset audit entry remained visible. |
| Session C04 tests | HTTP 200. Negative rainfall was rejected and out-of-training-range features returned low confidence. Both left the budget unchanged. |
| Session C08 tests and stateless drift check | HTTP 200. Stable distribution returned `stable` and residual bias returned `retrain_recommended`, with unchanged budget. Identical arrays returned `stable` on the stateless route. |
| C15 Balanced and Aggressive | HTTP 200. Balanced returned PKR 29,000,000 headline gain, PKR 25,500,000 fully loaded net, and PKR 45,000,000 missed exposure. Aggressive returned PKR −9,500,000 headline net. **ASSUMPTION - replace with municipal data.** |
| C15 worked example and headline break-even | HTTP 200. The worked example returned PKR 8,500,000 headline and PKR 7,500,000 fully loaded. One true detection per nine false alarms returned PKR 0 headline net and 10% break-even precision. **ASSUMPTION - replace with municipal data.** |
| Model registry, saved benchmark, measured impact, and live drift | Raw AIFS was available. Team models were `not-trained`, and benchmark, C15 Measured, and live drift reported `unavailable` because local artifacts were missing. |
| All documented API routes | All 24 routes were exercised, including legacy health. Session creation returned HTTP 201 and the other successful calls returned HTTP 200. |
| Database writes during reads | After schema initialization, snapshots of all six tables were identical before and after the 16 GET routes. The stateless C15 and C08 POSTs also left the rows unchanged. |
| Browser rehearsal | The full pitch click path was exercised at 1440×900 and 390×844. No page-wide horizontal overflow or browser console warnings or errors were observed. |

See [Tests](#tests) for checks that run with mocked weather providers and an
isolated test database. They exercise simulated allocation and budget effects
without requiring a live storm. The [prior benchmark record](#prior-benchmark-record-10-nov-2026)
is included for historical context. Restoring the original dataset and exports is
necessary to reproduce its model scores and run the artifact-dependent tests.

## Dashboard walkthrough

1. **Check live forecast now.** Read the source, model-run time, next-24-hour window,
   and data status before interpreting the total. The forecast card shows both UTC
   and Karachi local time. Satellite tiles show a separately dated observation.
2. **Run Calm, then Severe storm twice.** Calm is 40 mm and stays below the default
   80 mm threshold. Severe storm is 96 mm. In a fresh session the first run records
   a single simulated PKR 500,000 allocation, leaving PKR 1,500,000. Repeating the
   same scenario in that session leaves the balance unchanged.
3. **Check edge conditions.** Exact threshold is 80 mm and qualifies at the
   default threshold if budget remains. Stale data supplies a synthetic 96 mm
   total with an old run and cannot allocate. Select **Return to live forecast**
   when done with the demo scenarios.
4. **Run C04 Guard test.** Try `impossible-magnitude` and
   `out-of-training-range-features` to see rejection and low confidence. Confirm
   the reason codes, unchanged budget, and audit record. The dry control passes
   validation and creates no allocation.
5. **Open C15 Boardroom impact.** Compare Balanced and Aggressive in **What-if** to
   see the cost of false alarms, then use **This session** to inspect the actual
   simulated spend. Export the currently selected summary as Markdown. **Measured**
   shows unavailable until the saved benchmark is restored.
6. **Run C08 Concept drift detection.** Choose **Residual bias** to see a
   retraining recommendation with stable inputs, then **Dry-season calendar shift**
   to see seasonal tags without a retraining recommendation. Inspect the feature
   histogram, reasons, and unchanged budget. The Challenge scoreboard summarizes
   the evidence and gaps for all three challenges.
7. **Inspect the audit trail.** Open the relevant event and check the decision,
   trigger, forecast context, and budget before and after. **Reset session**
   clears that session's decisions and allocations and restores its starting
   budget. The audit history includes the reset.

## API reference

Paths below are relative to `/api/v1`. Request bodies and responses are JSON with
camelCase fields. A typical validation error has the shape
`{ "error": { "code": "...", "message": "..." } }`.

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/health` | Database, scheduler and model status |
| GET | `/areas` | Karachi |
| GET | `/areas/karachi/forecast` | Live forecast, read-only |
| GET | `/areas/karachi/satellite` | GIBS layer metadata |
| POST | `/demo/sessions` | `{ sessionId, dashboard }`, live mode, full simulated budget |
| GET | `/demo/sessions/{id}/dashboard` | Read-only snapshot |
| POST | `/demo/sessions/{id}/evaluate-live` | Fetch + evaluate; blocked if stale/unverified |
| POST | `/demo/sessions/{id}/scenarios` | Body `{ "scenarioId": "severe-storm" }` |
| GET | `/guard/cases` | Lists the five C04 demo cases and one control. |
| POST | `/demo/sessions/{id}/guard-test` | Body `{ "caseId": "negative-rainfall" }`. Returns the verdict, decision, audit record and before/after budget. |
| POST | `/demo/sessions/{id}/reset` | Resets only that session |
| GET | `/demo/sessions/{id}/audit` | Audit records |
| GET | `/models` | AIFS, Random Forest, neural network |
| GET | `/models/benchmark` | Saved real benchmark or `unavailable` |
| GET | `/models/comparison?areaId=karachi&date=YYYY-MM-DD` | Same fixed UTC day for all three; never allocates |
| GET | `/impact/assumptions` | Current C15 inputs, labels, units and source notes. |
| GET | `/impact/measured` | Per-model saved 80 mm test counts and assumption-based breakdown, or `unavailable`. |
| POST | `/impact/scenario` | Stateless what-if calculation with a sensitivity grid and false-alarm curve. |
| GET | `/demo/sessions/{id}/impact` | Read-only simulated spend and assumption-based break-even hurdle. |
| GET | `/drift/cases` | Six deterministic C08 demo cases with expected verdicts and reason codes. |
| POST | `/demo/sessions/{id}/drift-test` | Body `{ "caseId": "concept-drift-residual-bias" }`. Persists the check and audit record and returns both budget values. |
| GET | `/drift/status` | Real archived-window status with an observation-lag note. Read-only and requires a trusted reference. |
| POST | `/drift/evaluate` | Stateless single-feature comparison. Body `{ "reference": [...], "current": [...], "bins": 10 }`. |

The legacy `GET /api/health` route is outside this prefix. It runs a basic
database probe and returns `{ "ok": true }` or HTTP 500 with `{ "ok": false }`.
Use `/api/v1/health` for schema, scheduler, and model status.

Read endpoints do not run a funding evaluation or create allocations. Health
and some session reads can initialize tables on first use. Opening the browser
dashboard can send a separate `POST /evaluate-live` after loading the session.
Treat session IDs as
demo state identifiers. They provide no authentication or authorization.

### Smoke test from PowerShell

This creates a separate demo session, runs a rejected C04 case, and calculates
a C15 what-if. It does not reset your browser's session.

```powershell
$base = 'http://localhost:3000/api/v1'
Invoke-RestMethod "$base/health"
$session = Invoke-RestMethod "$base/demo/sessions" -Method Post
$sessionPath = "$base/demo/sessions/$($session.sessionId)"
$guard = Invoke-RestMethod "$sessionPath/guard-test" -Method Post -ContentType 'application/json' -Body '{"caseId":"negative-rainfall"}'
$guard.guard
$guard.budgetBeforePkr -eq $guard.budgetAfterPkr  # True
$scenario = Invoke-RestMethod "$base/impact/scenario" -Method Post -ContentType 'application/json' -Body '{"eventCount":10,"recall":0.7,"falseAlarmCount":5}'
$scenario.impact.netFinancialGainPkr              # 29000000 with defaults, assumption-based
```

## Forecast time handling

- Open-Meteo hourly precipitation is the total of the **preceding** hour. The dashboard window is the next
  24 complete hours: at 10:25 UTC it is 11:00 → 11:00, i.e. the values stamped 12:00 … 11:00.
- All 24 values must exist and be finite and non-negative, in mm; otherwise the forecast is `invalid`
  with a `null` total. The hourly values add up to the returned total.
- `modelRunAt` (from provider metadata, then requested explicitly), `providerAvailableAt` and `retrievedAt`
  are kept separate. `generationtime_ms` is never used as a model time.
- If the run cannot be pinned, the forecast is shown as `unverified` and cannot trigger funding.
- AIFS output on Open-Meteo is 6-hourly; hourly values are Open-Meteo's interpolation (disclosed in the UI).

| Forecast status | What the dashboard can show | Funding eligibility |
| --- | --- | --- |
| `fresh` | Pinned AIFS run within the configured age limit | Eligible only if C04 accepts the inputs and the other rule conditions pass |
| `stale` | A pinned run past the age limit | Blocked |
| `unverified` | Values without a verified current run | Blocked |
| `invalid` | A validation reason and a null total | Blocked |
| `unavailable` | Provider failure reason and a null total | Blocked |

## The simulated funding rule

```
IF   guard accepts the input  AND  forecast is valid and fresh
AND  rainfall >= 80 mm (next 24 h)
AND  policy is active  AND  simulated budget is sufficient
AND  the event has no allocation yet
THEN record ONE simulated PKR 500,000 allocation
ELSE no allocation, with the reason recorded
```

- Integer PKR amounts. Initial simulated budget PKR 2,000,000.
- The session row is locked, the allocation insert is protected by a database uniqueness constraint on
  **session + policy + event**, and the budget is deducted in the **same transaction**. Tests fire 8
  concurrent requests and confirm one allocation and one deduction.
- Demo event IDs are stable per scenario. Live event IDs use
  `LIVE-KARACHI-YYYYMMDD` with the UTC date of the forecast window start and can
  be reused while a prior allocation's window overlaps. They are demonstration IDs.
- **Automatic checks:** an in-process timer re-fetches the forecast every `LIVE_REFRESH_MINUTES` and
  evaluates recently active live sessions. It requires the server process to stay running and is **not**
  a multi-worker production scheduler. It sends no alerts.
- Reset restores the budget and clears allocations for that session only; the audit trail is append-only.

## Out-of-bounds & hallucination guard (C04)

The guard checks inputs from Open-Meteo and the synthetic demo scenarios before they reach the funding rule.
It also checks the archived AIFS window and the team models' eight input features before model comparison.

| Verdict | Meaning | Funding |
| --- | --- | --- |
| `accepted` | Every applicable check passed. Confidence is `1`. | Eligible for the existing freshness, rainfall, budget and event checks. |
| `low_confidence` | A soft cap or feature-range check fired. The heuristic score is `1 / (1 + number of soft reasons)`. | Blocked before event ID assignment. The forecast card shows the verdict and reasons in place of the headline total. |
| `rejected` | At least one rejection reason. Confidence is `null`. | Blocked before event ID assignment. Rejected forecast totals and predictions are unavailable. |

### Checks and rationale

1. Latitude must be within −90° to 90° and longitude within −180° to 180°. The default service rectangle
   (23°–37° N, 60°–78° E) covers the app's Pakistan locations and catches points far outside the intended region.
   It is a bounding box rather than a national boundary.
2. A forecast needs 24 finite, nonnegative hourly values. Strings, nulls, booleans, NaN, infinity and the
   NASA missing-data sentinel −999 are rejected. Timestamps, when supplied, must identify consecutive UTC
   hour boundaries. The provider extractor also rejects duplicate hourly timestamps.
3. A supplied total must agree with the hourly sum to within 0.05 mm, which allows small rounding
   differences. The guard checks unrounded hourly values before the forecast total is rounded for the API.
4. The 100 mm hourly and 500 mm daily soft caps flag unusually large inputs for review. The 150 mm hourly
   and 1,000 mm daily hard caps reject magnitudes this demo is designed to screen out. The bounds use strict
   greater-than comparisons, so equality at a hard cap can still receive a soft flag. The caps are
   engineering sanity limits, independent of the 80 mm funding example.
5. The model comparison checks AIFS 24-hour total, maximum hourly value, wet-hour count, maximum six-hour
   block, latitude, longitude and day-of-year sine and cosine against observed training min/max values.
   The envelope also carries the 1st and 99th percentiles for inspection. Missing or malformed envelopes
   flag team-model inputs as low confidence. Valid team-model predictions with that flag remain
   informational. Only the raw live AIFS forecast can enter the live funding rule.

The comparison runtime expects `feature_envelope.json` in `MODEL_ARTIFACTS_DIR` (default `backend/artifacts`).
The schema contains `featureOrder` in the same order as `FEATURES` in `src/lib/floodfund/ml-runtime.ts`,
an ISO `generatedAt` timestamp, and a `features` object mapping each feature name to
`{ "min": number, "p1": number, "p99": number, "max": number }`. Derive those statistics from the original
chronological **training split only** when the Python pipeline and dataset are restored.
This checkout does not contain a measured envelope or the Python predictor.

### Demo inputs and expected results

Open `/dashboard` and use **Guard test**. Each Run button evaluates one fixed synthetic input against the
default guard settings. The control is dry so it passes validation and stays below the funding threshold.
The extrapolation test uses a synthetic dry envelope to exercise the range check without depending on
training artifacts. That envelope is isolated to the demo.

| Case ID | Synthetic input | Verdict | Reason codes | Allocation |
| --- | --- | --- | --- | --- |
| `negative-rainfall` | One hour at −5 mm | Rejected | `NEGATIVE_RAINFALL` | None |
| `impossible-magnitude` | 900 mm then two 60 mm hours, totaling 1,020 mm | Rejected | `HOURLY_EXCEEDS_HARD_CAP`, `TOTAL_EXCEEDS_HARD_CAP` | None |
| `invalid-coordinates` | Lat 123.4°, lon −400° | Rejected | `INVALID_LATITUDE`, `INVALID_LONGITUDE` | None |
| `missing-or-corrupt-series` | 23 hours, including NaN and −999 | Rejected | `WRONG_HOURLY_COUNT`, `NON_FINITE_VALUE`, `SENTINEL_VALUE` | None |
| `out-of-training-range-features` | 24 × 4 mm, outside the synthetic envelope | Low confidence | `FEATURE_OUT_OF_TRAINING_RANGE` on four rainfall features | None |
| `normal-valid-input` | 24 × 0 mm | Accepted | — | None |

For API use, list IDs with `GET /api/v1/guard/cases`, create a session with
`POST /api/v1/demo/sessions`, and submit `{ "caseId": "negative-rainfall" }` to
`POST /api/v1/demo/sessions/{id}/guard-test`. Unknown IDs return HTTP 400 with
`error.code: "invalid_guard_case"`. Each successful test returns the audit record from its own
transaction, including reason codes, plain-language text and budget before and after. Test runs
leave the selected live forecast or scenario in place. Read the session audit via
`GET /api/v1/demo/sessions/{id}/audit`. Read-only forecast and comparison responses expose the
verdict without appending an audit record. Manual, scheduled, and scenario evaluations append
blocked verdicts when they run against a session.

Run `npx vitest run tests/guard.test.ts` for guard-only coverage, or `npx vitest run` for the
full web suite including PostgreSQL-backed scenario, audit and concurrency tests. The 80 mm
boundary and eight concurrent qualifying evaluations remain covered by the original funding tests.

The guard can catch malformed inputs, configured extremes and simple feature extrapolation. A plausible
but wrong rainfall forecast can still pass. The score is a heuristic rather than a probability or
an estimate of flood risk. The original dataset covers one monsoon season, which limits what a measured
feature envelope can establish about conditions outside that season.

## Net financial impact model (C15)

**ASSUMPTION - replace with municipal data.** Every monetary output here is a
what-if calculation under the stated assumptions or a record of simulated spend.
FloodFund records no actual savings and moves no real money.

```text
Net Financial Gain = Loss Averted by True Detections - Operational Cost of False Alarms
Loss per event     = portfolio asset value × exposed fraction × damage ratio
Averted per TP     = loss per event × mitigation effectiveness
Headline net       = TP × averted per TP − FP × false-alarm cost per event
Fully loaded net   = headline net − TP × simulated policy allocation
Missed exposure    = FN × loss per event
```

TP is a correctly predicted threshold exceedance, FP a false alarm, FN a missed
exceedance and TN a correctly predicted non-exceedance. Missed-event exposure is
shown separately. Return on simulated spend divides headline net by false-alarm
cost plus true-detection spend, and is unavailable when spend is zero.

| Input | Default | Why this value is here |
| --- | --- | --- |
| Portfolio asset value | PKR 5,000,000,000 | ASSUMPTION - replace with municipal data. A round placeholder for assets within scope. |
| Portfolio exposed per event | 2% | ASSUMPTION - replace with municipal data. Demonstrates partial exposure. |
| Damage ratio | 15% | ASSUMPTION - replace with municipal data. Demonstrates partial damage to exposed assets. |
| Mitigation effectiveness | 30% | ASSUMPTION - replace with municipal data. Demonstrates that timely action averts only some damage. |
| False-alarm cost | PKR 500,000 simulated allocation + PKR 0 extra | ASSUMPTION - replace with municipal data. Starts from the configured simulated policy allocation. Additional operational cost is configurable. |
| Cost of a miss | Exposure only | ASSUMPTION - replace with municipal data. Shows unmitigated loss separately from the challenge formula. |

**Worked what-if.** Under those assumptions, a threshold event exposes PKR 100,000,000
in assets, with PKR 15,000,000 in loss and PKR 4,500,000 averted per true detection.
Two true detections and one false alarm give PKR 9,000,000 − PKR 500,000 =
**PKR 8,500,000 headline gain**. Counting the two simulated allocations on true
detections gives **PKR 7,500,000 fully loaded net**. An additional miss would show
PKR 15,000,000 in separate assumed exposure.

**Break-even.** For positive avoided loss per TP (`A`) and false-alarm cost (`C`),
`TP × A = FP × C` gives `TP/FP = C/A` and precision `C/(A+C)`. At the
defaults this is one detection per nine false alarms, or 10% precision, for the
headline formula only. Zero avoided loss yields an unavailable break-even ratio
with a reason. The session hurdle is simulated spend divided by `A`, rounded up
to a whole detection.

### Boardroom modes

- **Measured** uses the saved `benchmark.json` test metrics at ≥ 80 mm for raw AIFS,
  Random Forest and the neural network. It uses saved TP/FP/FN where available.
  If TP is absent, it can derive it from saved counts, zero predicted/reference
  positives, or precision/recall that imply an integer count. TN is the test
  example count minus TP, FP and FN. Missing or inconsistent evidence returns
  `unavailable`. The earlier benchmark documented below has **0 true detections,
  0 false alarms and 1 miss per model**. Applying the assumptions to those counts
  gives **PKR 0 headline gain** and **PKR 15,000,000 missed-event exposure** per
  model. This checkout lacks the file, so the endpoint reports `unavailable`.
- **What-if** lets you change events per season, recall, false-alarm count and
  assumptions. True detections are the nearest whole count to events × recall,
  with halves rounded up, and misses are the remaining events. TN is unknown
  because the number of non-event days is unspecified. The panel plots the
  effect of more false alarms and shows a 5 × 5 grid varying damage and mitigation
  at fixed counts. Edits are local and never affect the funding rule.
- **This session** uses the actual count and total of simulated allocations. For
  example, one PKR 500,000 simulated allocation needs at least one true detection
  to cover spend under the assumptions. The allocation itself establishes no
  event outcome or avoided loss.

All presets below are **illustrative what-if** calculations using ten assumed events.

| Preset | Recall | TP / FP / FN | Assumption-based headline net | Assumption-based fully loaded net |
| --- | ---: | --- | ---: | ---: |
| Conservative | 50% | 5 / 2 / 5 | PKR 21,500,000 | PKR 19,000,000 |
| Balanced | 70% | 7 / 5 / 3 | PKR 29,000,000 | PKR 25,500,000 |
| Aggressive | 90% | 9 / 100 / 1 | PKR −9,500,000 | PKR −14,000,000 |

The dashboard can download a Markdown summary of the selected mode with the
numbers, assumptions and disclaimer. API clients can submit a what-if directly:

```json
{
  "eventCount": 10,
  "recall": 0.7,
  "falseAlarmCount": 5,
  "overrides": { "mitigationEffectiveness": 0.3 }
}
```

Send this to `POST /api/v1/impact/scenario`. The editable keys from
`GET /api/v1/impact/assumptions` are `portfolioAssetValuePkr`,
`exposedFractionPerEvent`, `damageRatio`, `mitigationEffectiveness`, and
`falseAlarmExtraCostPkr`. API inputs must be JSON numbers. Counts are whole numbers
from 0 to 10,000, fractions run from 0 to 1, and monetary inputs are whole PKR.
The portfolio is capped at PKR 100 billion and the extra cost at PKR 1 billion.
Out-of-range or malformed requests return HTTP 400 with the standard error body.
Exact decimal products use `BigInt` internally, round half up only at each final PKR
output, and are returned as safe JSON integers. Run `npx vitest run tests/impact.test.ts`
for the calculation and API tests, or the full suite for the session read and
budget-isolation test.

To replace the assumptions, a municipality would need a current asset register,
historical event footprints and losses linked to those assets, evidence of losses
avoided by timely preparedness, and the real marginal cost of a false alarm.
The benchmark has one reference threshold exceedance, uses location-days as
examples, and measures rainfall rather than damage. Events and assets can share
losses, and this calculation does not model those dependencies, discounting, or
insurance effects.

## Concept drift detection (C08)

C08 monitors the input and error distributions of the Random Forest and neural network
post-processors. It has no path into the raw AIFS funding rule, which still evaluates
the next 24 hours against the default 80 mm threshold. A retraining recommendation is
informational and triggers no training job or model replacement.

### What the statistics check

- **Covariate drift.** The eight features are AIFS daily total, maximum hourly rainfall,
  wet-hour count, maximum six-hour block, latitude, longitude, and day-of-year sine and cosine.
  Population Stability Index (PSI) uses reference quantile bins for both windows and computes
  `Σ (current share − reference share) × ln(current share / reference share)`.
  Duplicate quantile edges are merged and bin counts get `0.0001` smoothing before shares
  are calculated. A constant reference returns PSI 0 with `CONSTANT_REFERENCE`.
  KS can still flag a change in that feature.
- **Distribution significance.** The two-sample Kolmogorov–Smirnov (KS) statistic D is
  the largest gap between the empirical cumulative distributions. Tied observations
  advance both distributions before taking the difference. The two-sided asymptotic p-value
  uses the continuous-sample null approximation. The default Bonferroni threshold is
  `0.01 / 8 = 0.00125` for the feature family and `0.01` for a single-feature API request.
  [SciPy's two-sample KS reference](https://docs.scipy.org/doc/scipy/reference/generated/scipy.stats.ks_2samp.html)
  describes the continuous-distribution assumptions.
- **Residual shift.** For a team model with matched observations, compare signed
  errors (prediction minus observed rainfall) against validation residuals for the same
  model. C08 reports the mean shift in mm, an approximate 95% normal interval for the
  difference of means, and KS D and p-value. It flags a shift when KS p is below the
  configured alpha and the interval excludes zero. This is evidence of changed errors
  and a reason to investigate possible concept drift. Residuals are limited to dates with
  a usable NASA POWER value. Recent observations can be provisional IMERG Late Run
  data and may change when Final Run data become available.
- **Seasonal shift.** When the current window includes a date outside April–September,
  a change in either day-of-year feature is labeled `seasonal`. Those features remain
  visible and are excluded from the overall warning and retraining counts.

With the default settings, PSI below 0.10 is stable on the PSI check, 0.10–0.25 is
the warning band, and above 0.25 is high. The minimum of 30 samples per side avoids
making verdicts from very small windows. These are demonstration cutoffs. The overall
verdict is `insufficient_data` if any feature falls below the sample requirement.
Otherwise residual drift or at least three non-seasonal features with PSI above 0.25
and significant KS gives `retrain_recommended`. Any other non-seasonal PSI warning
band or significant KS result gives `warning`. The remaining cases are `stable`.
An unavailable or undersized residual window does not block a feature-only verdict.

### Live reference and observation requirements

Place `drift_reference.json` in `MODEL_ARTIFACTS_DIR`. The schema uses an ISO
`generatedAt`, `featureOrder` matching `FEATURES` in `ml-runtime.ts`, and a
`features` object mapping each feature name to an array of finite values from the
**training split only**. Set `trainingEnd` to the last training date (YYYY-MM-DD)
to exclude training dates from the current window. The optional `residuals` object
contains `modelId` (`random-forest` or `neural-network`), `validationEnd`
(YYYY-MM-DD), and a `values` array of signed validation residuals. Use the same model
version for the reference residuals and the deployed predictions.

The server records at most one sample per completed Karachi UTC date when a user
successfully runs the archived **Model comparison** for that date. `GET /drift/status`
uses the samples already seen by the current server process from the last 90 completed
UTC days. It fetches no provider data and writes no audit rows. Restarting the process
clears that rolling sample cache. Missing reference data gives `unavailable`, and a
short current window gives `insufficient_data`. Residuals use only dates after the
validation cutoff where NASA POWER has a value and a team model produced a number.
The original pipeline and reference artifact are absent in this checkout.

### Demo cases and expected outcomes

On `/dashboard#drift`, click **Run** next to a **DEMO / SYNTHETIC** case. The cases
use independent, fixed data and the default thresholds so they are reproducible.
Every run records its result in `ff_drift_checks` and appends an audit entry with
reason codes and the unchanged simulated budget. Resetting a session preserves its
drift checks and audit history. Real monitoring never uses the demo reference.

| Case ID | Synthetic change | Expected verdict | Main reason |
| --- | --- | --- | --- |
| `stable-same-distribution` | Identical distributions | Stable | No feature flags |
| `covariate-shift-heavier-rain` | Four rainfall features shift | Retrain recommended | `PSI_ABOVE_DRIFT`, `KS_SIGNIFICANT` |
| `concept-drift-residual-bias` | Inputs match, signed errors shift +8 mm | Retrain recommended | `RESIDUAL_SHIFT` |
| `seasonal-shift-dry-season` | Day-of-year features shift outside the monsoon window | Stable overall, seasonal features | `SEASONAL_SHIFT_EXCLUDED` |
| `insufficient-data` | Only 10 current observations per feature | Insufficient data | `INSUFFICIENT_SAMPLE` |
| `single-feature-warning` | 12 of 100 daily totals move into the first bin | Warning | `PSI_IN_WARNING_BAND` |

Use `GET /api/v1/drift/cases` to list cases and
`POST /api/v1/demo/sessions/{id}/drift-test` to run one. Unknown case IDs return
HTTP 400 with `error.code: "invalid_drift_case"`. The stateless endpoint accepts
up to 100,000 finite numbers per array and an optional whole-number `bins` between
2 and 50. It returns `invalid_drift_input` for malformed input and
`insufficient_data` for well-formed samples below the minimum. Run
`npx vitest run tests/drift.test.ts` for statistics, cases, API validation, and
archived-window tests. The full suite checks that C08 persistence leaves budgets
unchanged and that a qualifying live AIFS allocation still goes through.

**Limitations.** The original project dataset covers one monsoon season. PSI depends
on binning and how many samples reach each bin. KS p-values are approximate for small
or tied samples, and weather samples close in time can be dependent. Bonferroni
addresses simultaneous feature checks in one window and does not account for repeated
monitoring over time. The residual interval is approximate and uses available matched
observations. A distribution change does not establish accuracy loss or predict flooding.

## Models

| Model | Trained by | What it is |
| --- | --- | --- |
| ECMWF AIFS (raw) | **ECMWF** | Global AI weather model. The live dashboard forecast. |
| Team Random Forest | **Our team** | scikit-learn `RandomForestRegressor`; adjusts AIFS output towards NASA IMERG. |
| Team neural network | **Our team** | scikit-learn `StandardScaler → MLPRegressor`, same features. |

Our two models take AIFS as **input**. They are post-processors, not independent weather models.
Features: AIFS 24 h total, max hourly, wet hours, max 6-hour block, latitude, longitude, day-of-year sin/cos.
Target: NASA POWER IMERG rainfall for the same UTC day.

### Restore the original pipeline before training

The previous project record lists the workflow below. This checkout contains no
`backend/` directory, so the Python commands, dataset, and exported metrics could
not be independently verified here. Run them only after restoring the original source.

Restore the original `backend/ml/` pipeline, Python requirements and tests, and the
dataset or cached raw inputs under `backend/storage/raw/` (or the original
equivalent). Restore `model_metadata.json`, `random_forest.export.json`,
`neural_network.export.json`, `benchmark.json`, and `parity_sample.json` in the
configured artifact directory. The original dataset and model versions are also
needed to derive a training-only `feature_envelope.json` and `drift_reference.json`
with any available validation residuals. No replacements were generated in this checkout.

```bash
cd backend
pip install -r requirements.txt
python -m ml.collect_data --days 200 --max-locations 6   # the run used for the saved artifacts
python -m ml.build_dataset
python -m ml.train
python -m ml.evaluate
python -m ml.predict --date 2026-09-01 --location karachi
python -m pytest -q
```

The earlier record describes resumable downloads in `backend/storage/raw/`.
Open-Meteo documents AIFS single-run coverage starting on **2 April 2026**. That
limits the period that can be matched to the longer NASA POWER archive. Check which
dates have observations and whether Late Run values are acceptable for your benchmark.
[Open-Meteo Single Runs API](https://open-meteo.com/en/docs/single-runs-api) · [NASA POWER meteorology sources](https://power.larc.nasa.gov/docs/methodology/data/sources_meteorology/)

Supply trusted files locally under `MODEL_ARTIFACTS_DIR` (default `backend/artifacts`).

| Feature | Files used by this checkout |
| --- | --- |
| Team-model inference | `model_metadata.json`, `random_forest.export.json`, and `neural_network.export.json` |
| Saved benchmark report | `benchmark.json` with the trained-model metadata and exports for the Model Comparison panel |
| C15 Measured | A valid real, matched-row `benchmark.json` at 80 mm. Model binaries are not required. |
| C04 team-model range checks | `feature_envelope.json` |
| C08 live drift | `drift_reference.json` and enough archived samples. Residuals additionally need team-model predictions and matched observations. |
| Python-to-TypeScript parity test | `parity_sample.json` and the model exports |

The earlier Python workflow also listed `.joblib` files, a dataset summary, and
validation and test metric exports. The Next.js runtime reads JSON only and has
no artifact upload path or startup training job. Missing team-model files are
reported as `not-trained`.

### Prior benchmark record (10 Nov 2026)

The figures below are preserved from the earlier project record. They have not
been reproduced from the original dataset or `benchmark.json` in this checkout.

Dataset: **990 location-days**, 165 dates (2026-04-03 → 2026-09-14), 6 locations (Karachi, Hyderabad, Badin,
Sukkur, Lahore, Islamabad). Chronological split by date: train 582 rows (04-03 → 07-08), validation 192
(07-09 → 08-09), test 216 (08-10 → 09-14). Only **one** reference location-day reached 80 mm in the whole dataset.

| Test set (216 rows, 36 dates) | MAE mm | RMSE mm | Ref ≥ 80 | Pred ≥ 80 | Precision | Recall | False triggers |
| --- | --- | --- | --- | --- | --- | --- | --- |
| ECMWF AIFS (raw) | **2.88** | 11.14 | 1 | 0 | null | 0.0 | 0 |
| Team Random Forest | 3.07 | **10.29** | 1 | 0 | null | 0.0 | 0 |
| Team neural network | 4.65 | 13.73 | 1 | 0 | null | 0.0 | 0 |

Validation MAE: AIFS 3.06, Random Forest 3.30, neural network 3.81 mm.

In the recorded results, raw AIFS had the lowest validation and test MAE. The reported
Random Forest test MAE difference (+0.19 mm, 95% interval −0.11 to +0.51) includes zero.
The forest's reported RMSE was lower. The recorded neural-network test MAE difference
was +1.77 mm (interval +0.67 to +3.02). All three models missed the sole ≥ 80 mm
reference location-day. With zero predicted positives, precision is undefined.
One reference exceedance gives too little evidence to establish threshold skill.
The recorded recommendation was raw AIFS, with reliability flagged. These metrics
measure agreement with a satellite rainfall estimate.

### Why the benchmark window differs from the dashboard

NASA POWER rainfall is daily on **fixed UTC calendar days**, so the benchmark compares a UTC day (00:00–24:00)
using the AIFS run from 12:00 UTC the day before (12–36 h lead, decision cut-off 22:00 UTC). The dashboard
uses the **rolling next 24 hours** from the latest run. Our models were not trained or tested on the rolling
window, so AIFS remains the live forecast. Historical availability of archived runs before the cut-off is
**assumed** (≤ 10 h after initialisation), which makes this a retrospective benchmark, not a verified
operational backtest. IMERG values may be revised by NASA.

## Tests

```bash
npx vitest run                    # Full web suite, including PostgreSQL-backed tests
npx vitest run tests/guard.test.ts tests/impact.test.ts tests/drift.test.ts
npm run typecheck
npm run lint
npm run build
```

External providers are mocked. Use a **test PostgreSQL database** in `DATABASE_URL`
for the full suite. The integration tests create isolated sessions and clean up
their own test rows. The focused C04/C15/C08 tests require a configured environment
but do not connect to PostgreSQL.

| Test area | Coverage |
| --- | --- |
| `tests/providers.test.ts` | Rolling UTC window, run freshness, unavailable providers, satellite metadata, and live guard response |
| `tests/funding.test.ts` | Session isolation, exact 80 mm boundary, budget and event deduplication, guard audit entries, C15 session spend, and concurrency |
| `tests/guard.test.ts` | Input types, sentinel, coordinate and rainfall bounds, soft flags, training envelope, five injections and dry control |
| `tests/impact.test.ts` | Integer-PKR arithmetic, break-even, invalid requests, sensitivity, and saved benchmark handling |
| `tests/drift.test.ts` | PSI and KS statistics, seasonal and residual flags, six demo cases, validation, and reuse of archived features |
| `tests/models.test.ts` | Artifact availability, archived comparison, and parity with the saved Python model exports when present |

Finalization verification on 11 November 2026 used isolated PostgreSQL. The exact
Vitest summary was:

```text
 Test Files  6 passed (6)
      Tests  86 passed | 3 skipped (89)
```

There were zero failures. The skipped cases are Python/TypeScript prediction
parity, the saved matched-row benchmark test, and the C15 measured-impact
test against `benchmark.json`. The dashboard GET versus evaluate-live POST regression
test passed. TypeScript, lint, and the production build passed.
Pytest was not run because the original Python tree is missing. After restoring
it, run `python -m pytest -q` from `backend/`.

## Troubleshooting

| What you see | What to check |
| --- | --- |
| Dashboard page loads but says **Backend not connected** | Open `/api/v1/health`. HTTP 200 with `database: "ok"` confirms PostgreSQL connectivity. HTTP 503 with `database: "error"` points to connection, network, permissions, or schema initialization. Confirm the server process can reach the database and restart after changing `.env`. |
| Forecast is `unavailable`, `unverified`, `stale`, or `invalid` | Read the forecast status reason and C04 verdict. Confirm the server can reach Open-Meteo. Unverified and stale data cannot trigger funding. |
| Forecast is `fresh` but C04 shows **Low confidence** | Freshness and data validation are separate checks. Read the guard reasons. The funding engine blocks the evaluation even if the run is recent. |
| Satellite overlay is missing | Check `/api/v1/areas/karachi/satellite` and the map's layer status. Observation availability and tile loading are independent of the forecast and funding decision. |
| Measured impact is **Unavailable** or team models are **Not trained** | Check `MODEL_ARTIFACTS_DIR` and restore the original trusted artifacts for the feature you need. The What-if and session views remain available with the API and database running. |
| A repeated storm produces no new allocation | Look for `already_allocated` in the decision. The session has already allocated for that scenario's event. |
| Port 3000 is in use or Next.js reports a second dev server | Use the URL shown by the server already running for this project, or stop that server before starting another. The parent-folder lockfile warning is separate from the port or server-lock issue. |

## Deploying with persistent storage

- Use a managed UTF-8 PostgreSQL database and set `DATABASE_URL` in the platform's secret settings.
- Initialize the schema through the app or apply schema changes through your deployment process
  after verifying the target database. Keep database URLs and passwords out of tracked config files.
- Run **one** long-lived Node process (`npm run start`) so the in-process scheduler works. On serverless or
  multi-instance hosting, set `LIVE_SCHEDULER_ENABLED=false`. If you add an external scheduler,
  keep an explicit list of live session IDs to evaluate and call their `evaluate-live` endpoints.
  Database idempotency protects repeated evaluations. Limit access to the demo endpoints before
  exposing a deployment to other users.
- Supply the trusted model exports and benchmark in `MODEL_ARTIFACTS_DIR` if you want measured
  impact and team-model comparisons. Include the training envelope to enable feature-range checks.

## Limitations

- Not a flood model. AIFS is ~28 km and 6-hourly; nothing here is street-level.
- The threshold, event ID and budget are demonstration values. Sessions have no authentication.
- One monsoon season of data; one ≥ 80 mm reference day; neighbouring locations share storms and are not independent.
- Satellite imagery is a delayed estimate of past rain and never drives the rule.
- This demonstration issues no public alerts and must not be used for real decisions.
