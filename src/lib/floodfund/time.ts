import type { HourlyRain } from "./types";

export const HOUR_MS = 3_600_000;

/** Round half up to two decimals (identical formula in backend/ml/common.py). */
export function round2(value: number): number {
  return Math.floor(value * 100 + 0.5) / 100;
}

export interface HourlySeries {
  /** Unix seconds, UTC. Each value is the precipitation sum of the PRECEDING hour. */
  timesUnix: number[];
  values: (number | null)[];
  unit: string | null;
}

export type WindowResult =
  | { ok: true; hourly: HourlyRain[]; totalMm: number }
  | { ok: false; reason: string };

export type WindowInput =
  | { ok: true; values: unknown[]; timestamps: number[] }
  | { ok: false; reason: string; code: "WRONG_HOURLY_COUNT" | "INVALID_TIMESTAMP" | "NON_FINITE_VALUE"; field: string };

/**
 * Start of the "next 24 complete hours" window: the next full-hour boundary at
 * or after `nowMs`. At 10:25 the window is 11:00 -> 11:00 next day.
 */
export function rollingWindowStart(nowMs: number): number {
  return Math.ceil(nowMs / HOUR_MS) * HOUR_MS;
}

/** Start (UTC midnight, ms) of a `YYYY-MM-DD` day, or null if the string is not a real date. */
export function utcDayStart(date: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return null;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== date) return null;
  return ms;
}

/**
 * Select `hours` complete hourly intervals starting at `windowStartMs`.
 *
 * Open-Meteo hourly precipitation is the sum of the preceding hour, so the
 * interval [start + (i-1)h, start + i·h] is the value stamped start + i·h.
 * Every interval must be present, finite and non-negative. Missing data is
 * reported as a failure and is never converted to zero.
 */
export function extractWindow(series: HourlySeries, windowStartMs: number, hours = 24): WindowInput {
  if (series.unit !== "mm") {
    return { ok: false, code: "NON_FINITE_VALUE", field: "hourlyUnits", reason: `Rainfall values cannot be used with precipitation unit "${series.unit ?? "missing"}" (expected mm).` };
  }
  if (!Array.isArray(series.timesUnix) || !Array.isArray(series.values) || series.timesUnix.length !== series.values.length) {
    return { ok: false, code: "WRONG_HOURLY_COUNT", field: "hourlyMm", reason: "The provider returned time and precipitation arrays of different lengths." };
  }
  if (!Number.isFinite(windowStartMs) || windowStartMs % HOUR_MS !== 0) {
    return { ok: false, code: "INVALID_TIMESTAMP", field: "windowStart", reason: "The forecast window does not start on a full hour." };
  }
  const lookup = new Map<number, unknown>();
  for (let i = 0; i < series.timesUnix.length; i++) {
    const t = series.timesUnix[i];
    if (!Number.isSafeInteger(t) || Math.abs(t) > 8.64e12 || t % 3600 !== 0 || lookup.has(t)) {
      return { ok: false, code: "INVALID_TIMESTAMP", field: `hourlyTimes[${i}]`, reason: "The provider returned an invalid or duplicate hourly timestamp." };
    }
    lookup.set(t, series.values[i]);
  }
  const startSec = windowStartMs / 1000;
  const timestamps = Array.from({ length: hours }, (_, i) => startSec + (i + 1) * 3600);
  return { ok: true, timestamps, values: timestamps.map((t) => lookup.get(t)) };
}

export function selectWindow(series: HourlySeries, windowStartMs: number, hours = 24): WindowResult {
  const window = extractWindow(series, windowStartMs, hours);
  if (!window.ok) return window;
  const hourly: HourlyRain[] = [];
  let total = 0;
  for (let i = 0; i < hours; i++) {
    const endSec = window.timestamps[i];
    const endIso = new Date(endSec * 1000).toISOString();
    const v = window.values[i];
    if (v === null || v === undefined) {
      return { ok: false, reason: `Rainfall for the hour ending ${endIso} is missing. Missing data is not treated as zero.` };
    }
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
      return { ok: false, reason: `Rainfall for the hour ending ${endIso} is not a valid non-negative number.` };
    }
    hourly.push({
      intervalStart: new Date((endSec - 3600) * 1000).toISOString(),
      intervalEnd: endIso,
      precipitationMm: v,
    });
    total += v;
  }
  return { ok: true, hourly, totalMm: round2(total) };
}
