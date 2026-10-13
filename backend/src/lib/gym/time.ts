/**
 * Small, dependency-free time helpers shared by metrics and the importer.
 * Times of day are "HH:MM" strings (what the operator types); durations are
 * minutes. Anything that fails to parse yields null, never NaN.
 */

/** "HH:MM" or "HH:MM:SS" → minutes since midnight, or null. */
export function hhmmToMinutes(value: string | null | undefined): number | null {
  if (!value) return null;
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(value.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** minutes since midnight → "HH:MM" (wraps at 24 h). */
export function minutesToHhmm(minutes: number): string {
  const m = ((Math.round(minutes) % 1440) + 1440) % 1440;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return `${String(h).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
}

/**
 * Duration between two times of day in minutes. A window that crosses
 * midnight (night shift) is handled by adding a day. Null when either side
 * is missing or invalid.
 */
export function spanMinutes(
  start: string | null | undefined,
  end: string | null | undefined,
): number | null {
  const a = hhmmToMinutes(start);
  const b = hhmmToMinutes(end);
  if (a == null || b == null) return null;
  let d = b - a;
  if (d < 0) d += 1440;
  return d;
}

/** Round to one decimal, keeping null. */
export function round1(value: number | null): number | null {
  return value == null ? null : Math.round(value * 10) / 10;
}

/** Percent share, null when the base is not positive. */
export function percent(part: number, base: number | null): number | null {
  if (base == null || base <= 0) return null;
  return round1((part / base) * 100);
}

/**
 * The gym's wall clock. Logs are written in the cell's local time, bag files
 * carry epoch nanoseconds, and the server may run in UTC (docker). Every
 * conversion between the two goes through this zone so "11:13" in a log and
 * the same instant in a bag end up as the same time of day in a protocol.
 */
export const GYM_TIMEZONE: string = (() => {
  const tz = process.env.GYM_TIMEZONE || "Europe/Berlin";
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: tz });
    return tz;
  } catch {
    return "UTC";
  }
})();

const zoneFormat = new Intl.DateTimeFormat("en-GB", {
  timeZone: GYM_TIMEZONE,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

export interface ZoneParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** Calendar fields of an instant in the gym's time zone. */
export function zoneParts(d: Date): ZoneParts {
  const out: Record<string, number> = {};
  for (const p of zoneFormat.formatToParts(d)) {
    if (p.type !== "literal") out[p.type] = Number(p.value);
  }
  return {
    year: out.year ?? 1970,
    month: out.month ?? 1,
    day: out.day ?? 1,
    hour: (out.hour ?? 0) % 24,
    minute: out.minute ?? 0,
    second: out.second ?? 0,
  };
}

/** Offset of the gym zone against UTC at that instant, in minutes (Berlin summer: 120). */
export function zoneOffsetMinutes(ms: number): number {
  const z = zoneParts(new Date(ms));
  const asUtc = Date.UTC(z.year, z.month - 1, z.day, z.hour, z.minute, z.second);
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60_000);
}

/**
 * A naive wall-clock time ("2026-09-08", "11:13:50.903") read as gym time →
 * epoch ms. Two passes settle the offset around a DST switch.
 */
export function zoneDateTimeToMs(date: string, time = "00:00:00"): number | null {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date.trim());
  const t = /^(\d{1,2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,6}))?)?$/.exec(time.trim());
  if (!d || !t) return null;
  const frac = t[4] ? Number(`0.${t[4]}`) * 1000 : 0;
  const guess = Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3]), Number(t[1]), Number(t[2]), Number(t[3] ?? 0)) + Math.round(frac);
  if (Number.isNaN(guess)) return null;
  const first = guess - zoneOffsetMinutes(guess) * 60_000;
  return guess - zoneOffsetMinutes(first) * 60_000;
}

/** Date part "YYYY-MM-DD" of an instant in the gym's time zone. */
export function isoDate(d: Date): string {
  const z = zoneParts(d);
  return `${z.year}-${String(z.month).padStart(2, "0")}-${String(z.day).padStart(2, "0")}`;
}

/** "HH:MM" of an instant in the gym's time zone. */
export function isoTime(d: Date): string {
  const z = zoneParts(d);
  return `${String(z.hour).padStart(2, "0")}:${String(z.minute).padStart(2, "0")}`;
}

/** Minutes since midnight of an instant in the gym's time zone. */
export function zoneMinutesOfDay(ms: number): number {
  const z = zoneParts(new Date(ms));
  return z.hour * 60 + z.minute;
}

/** Fixed-format "HH:MM" from a number of minutes as duration text, e.g. 4 h 05 min. */
export function formatMinutes(minutes: number | null): string {
  if (minutes == null) return "–";
  const h = Math.floor(minutes / 60);
  const r = Math.round(minutes % 60);
  return h ? `${h} h ${String(r).padStart(2, "0")} min` : `${r} min`;
}

// ---------------------------------------------------------------------------
// Database timestamps
// ---------------------------------------------------------------------------

/**
 * The gym's timestamp columns are `timestamp without time zone` and hold the
 * UTC wall clock (everything is written as `new Date().toISOString()`). The
 * driver hands them back as "2026-09-08 09:13:50.903", a string that carries
 * no zone at all, so `new Date(...)` in a browser reads it as local time and
 * the clock is off by the browser's offset (two hours in Berlin summer).
 *
 * Every timestamp that leaves the API goes through this: the naive string
 * becomes a real instant, "2026-09-08T09:13:50.903Z". Values that already
 * carry a zone and values that are not timestamps are returned unchanged.
 */
const NAIVE_TIMESTAMP = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?)$/;

export function utcIso(value: string): string;
export function utcIso(value: string | null | undefined): string | null;
export function utcIso(value: string | null | undefined): string | null {
  if (!value) return null;
  const m = NAIVE_TIMESTAMP.exec(value);
  return m ? `${m[1]}T${m[2]}Z` : value;
}

/** The timestamp columns of the gym tables, by name. */
export const TIMESTAMP_KEYS = [
  "createdAt",
  "updatedAt",
  "startedAt",
  "closedAt",
  "sceneCapturedAt",
  "teleopStartedAt",
  "teleopEndedAt",
  "accessTokenExpiresAt",
  "reviewedAt",
  "trainedAt",
] as const;

/** A row on its way out of the API: its timestamp columns as real UTC instants. */
export function utcRow<T extends Record<string, unknown>>(row: T): T {
  const out = { ...row } as Record<string, unknown>;
  for (const key of TIMESTAMP_KEYS) {
    const value = out[key];
    if (typeof value === "string") out[key] = utcIso(value);
  }
  return out as T;
}

/** `utcRow` over a list. */
export const utcRows = <T extends Record<string, unknown>>(rows: T[]): T[] => rows.map(utcRow);
