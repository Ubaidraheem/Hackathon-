/**
 * Central configuration for the FloodFund Karachi API (the web service's
 * equivalent of `config.py`). Every server module imports `config` from here;
 * nothing else reads `process.env` for application settings.
 *
 * Values come from `.env` in the project root (loaded by Next.js) or from the
 * hosting platform's environment. No API keys are required: Open-Meteo,
 * NASA POWER, NASA GIBS and OpenStreetMap tiles are public, keyless services.
 */

import { IMPACT_INPUTS } from "./floodfund/impact";

function str(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v.trim() === "" ? fallback : v.trim();
}

function num(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const v = Number(raw);
  if (!Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, v));
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  return ["1", "true", "yes", "on"].includes(raw);
}

// Engineering sanity limits for this app, not meteorological claims or validated flood thresholds.
export const guardDefaults = {
  enabled: true,
  maxHourlyMm: 150,
  max24hMm: 1000,
  softHourlyMm: 100,
  soft24hMm: 500,
  coordBounds: [23, 37, 60, 78] as readonly [number, number, number, number],
  sumToleranceMm: 0.05,
};

function guardBounds(): typeof guardDefaults.coordBounds {
  const parts = str("GUARD_COORD_BOUNDS", "23,37,60,78").split(",");
  if (parts.length !== 4 || parts.some((part) => !part.trim())) return guardDefaults.coordBounds;
  const [south, north, west, east] = parts.map(Number);
  if (!(south >= -90 && south < north && north <= 90 && west >= -180 && west < east && east <= 180)) {
    return guardDefaults.coordBounds;
  }
  return [south, north, west, east];
}

const maxHourlyMm = num("GUARD_MAX_HOURLY_MM", guardDefaults.maxHourlyMm, 0.01, 10_000);
const max24hMm = num("GUARD_MAX_24H_MM", guardDefaults.max24hMm, 0.01, 240_000);

export const driftDefaults = { enabled: true, psiWarn: 0.10, psiAlert: 0.25, ksAlpha: 0.01, minSamples: 30, bins: 10, retrainFeatureCount: 3 };
const driftPsiAlert = num("DRIFT_PSI_ALERT", driftDefaults.psiAlert, 0.001, 100);

export const config = {
  appEnv: str("APP_ENV", "development"),
  /** Comma-separated origins allowed to call /api/v1 from another site. Empty = same-origin only. */
  corsOrigins: str("CORS_ORIGINS", "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  forecastCacheSeconds: num("FORECAST_CACHE_SECONDS", 300, 0, 3600),
  satelliteCacheSeconds: num("SATELLITE_CACHE_SECONDS", 1800, 0, 86400),
  /** A model run older than this is "stale" and cannot trigger the funding simulation. */
  modelMaxRunAgeHours: num("MODEL_MAX_RUN_AGE_HOURS", 18, 1, 96),
  liveSchedulerEnabled: bool("LIVE_SCHEDULER_ENABLED", true),
  liveRefreshMinutes: num("LIVE_REFRESH_MINUTES", 15, 1, 1440),
  sessionActiveHours: num("SESSION_ACTIVE_HOURS", 24, 1, 720),
  httpTimeoutMs: num("HTTP_TIMEOUT_MS", 10000, 1000, 60000),
  httpMaxRetries: num("HTTP_MAX_RETRIES", 1, 0, 3),
  /** Trusted, locally produced model artifacts (written by backend/ml). Never user-uploaded. */
  artifactsDir: str("MODEL_ARTIFACTS_DIR", "backend/artifacts"),
  guard: {
    enabled: bool("GUARD_ENABLED", guardDefaults.enabled),
    maxHourlyMm,
    max24hMm,
    softHourlyMm: Math.min(maxHourlyMm, num("GUARD_SOFT_HOURLY_MM", guardDefaults.softHourlyMm, 0, maxHourlyMm)),
    soft24hMm: Math.min(max24hMm, num("GUARD_SOFT_24H_MM", guardDefaults.soft24hMm, 0, max24hMm)),
    coordBounds: guardBounds(),
    sumToleranceMm: num("GUARD_SUM_TOLERANCE_MM", guardDefaults.sumToleranceMm, 0, 10),
  },
  drift: {
    enabled: bool("DRIFT_ENABLED", driftDefaults.enabled),
    psiWarn: Math.min(driftPsiAlert, num("DRIFT_PSI_WARN", driftDefaults.psiWarn, 0, 100)),
    psiAlert: driftPsiAlert,
    ksAlpha: num("DRIFT_KS_ALPHA", driftDefaults.ksAlpha, 0.000001, 0.25),
    minSamples: Math.round(num("DRIFT_MIN_SAMPLES", driftDefaults.minSamples, 2, 100_000)),
    bins: Math.round(num("DRIFT_BINS", driftDefaults.bins, 2, 50)),
    retrainFeatureCount: Math.round(num("DRIFT_RETRAIN_FEATURE_COUNT", driftDefaults.retrainFeatureCount, 1, 8)),
  },
  // ASSUMPTION - replace with municipal data.
  impact: {
    portfolioAssetValuePkr: Math.round(num("IMPACT_PORTFOLIO_ASSET_VALUE_PKR", 5_000_000_000, 0, IMPACT_INPUTS.portfolioAssetValuePkr.max)),
    exposedFractionPerEvent: num("IMPACT_EXPOSED_FRACTION_PER_EVENT", 0.02, 0, 1),
    damageRatio: num("IMPACT_DAMAGE_RATIO", 0.15, 0, 1),
    mitigationEffectiveness: num("IMPACT_MITIGATION_EFFECTIVENESS", 0.30, 0, 1),
    falseAlarmExtraCostPkr: Math.round(num("IMPACT_FALSE_ALARM_EXTRA_COST_PKR", 0, 0, IMPACT_INPUTS.falseAlarmExtraCostPkr.max)),
  },

  area: {
    id: "karachi",
    name: "Karachi",
    region: "Sindh",
    country: "Pakistan",
    latitude: 24.8607,
    longitude: 67.0011,
    note: "Single forecast point. The AIFS grid cell is about 0.25° (roughly 28 km) wide; this is not a street-level product.",
  },

  policy: {
    id: "KHI-RAIN-80MM-24H",
    name: "Karachi heavy-rainfall preparedness (demonstration)",
    areaId: "karachi",
    thresholdMm: num("POLICY_THRESHOLD_MM", 80, 1, 1000),
    windowHours: 24,
    allocationPkr: Math.round(num("POLICY_ALLOCATION_PKR", 500_000, 1, 1_000_000_000)),
    initialBudgetPkr: Math.round(num("POLICY_INITIAL_BUDGET_PKR", 2_000_000, 0, 2_000_000_000)),
    active: bool("POLICY_ACTIVE", true),
  },

  providers: {
    aifsModelId: "ecmwf_aifs025_single",
    openMeteoLiveUrl: "https://api.open-meteo.com/v1/ecmwf",
    openMeteoSingleRunsUrl: "https://single-runs-api.open-meteo.com/v1/forecast",
    openMeteoMetaUrl: "https://api.open-meteo.com/data/ecmwf_aifs025_single/static/meta.json",
    nasaPowerDailyUrl: "https://power.larc.nasa.gov/api/temporal/daily/point",
    gibsBaseUrl: "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best",
    gibsLayer: "IMERG_Precipitation_Rate",
    gibsTileMatrixSet: "GoogleMapsCompatible_Level6",
    gibsMaxNativeZoom: 6,
  },

  /** Must match backend/app/config.py (fixed UTC-day benchmark alignment). */
  benchmark: {
    runHourUtc: 12,
    decisionCutoffHoursBeforeTarget: 2,
    assumedPublicationLagHours: 10,
    wetHourMm: 0.1,
  },
} as const;

export type AppConfig = typeof config;
