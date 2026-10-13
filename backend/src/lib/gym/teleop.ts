/**
 * The time figures of a block (and, summed, of a day protocol).
 *
 * Three numbers answer three different questions, and they are deliberately
 * kept apart because they are measured in three different places:
 *
 *   teleopMinutes    how long the recording step was open, summed over every
 *                    open/close of the day. This is a tool-side figure: it
 *                    counts the time the operator spent in front of the cell
 *                    with a recording running, nothing else. It used to be
 *                    "last close minus first start", which grew every time a
 *                    day was reopened and counted every break in between.
 *   recordedSeconds  how much robot motion was actually recorded: the sum of
 *                    the episode durations of the uploaded datasets. This is
 *                    the only elapsed time that comes from the data itself;
 *                    everything else would have to be read out of the rosbags.
 *   downtimeMinutes  what the operator wrote down by hand, because a cell that
 *                    stands still leaves no trace in the tool at all.
 *
 * A window that is still open counts up to `now`, so the recording step can
 * show a running figure.
 */
import type { DowntimeEvent, TeleopInterval } from "../../db/schema";

export interface BlockTimes {
  /** sum of the windows of the block, in minutes: teleoperation in a recording block, policy time in an evaluation */
  teleopMinutes: number;
  /** true while a window is still open (the recording step is running) */
  teleopRunning: boolean;
  /** how often the recording step was opened */
  teleopSessions: number;
  /** sum of the episode durations of the block's datasets, in seconds */
  recordedSeconds: number | null;
  /** sum of the downtimes the operator wrote down, in minutes */
  downtimeMinutes: number;
}

const ms = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  // the database hands back naive UTC ("2026-09-08 09:13:50.903"); read it as UTC
  const value = /^\d{4}-\d{2}-\d{2} /.test(iso) ? `${iso.replace(" ", "T")}Z` : iso;
  const t = new Date(value).getTime();
  return Number.isNaN(t) ? null : t;
};

/** Minutes of one window, clamped at zero and ending at `now` while it runs. */
function windowMinutes(interval: TeleopInterval, now: number): number {
  const start = ms(interval.startedAt);
  if (start == null) return 0;
  const end = ms(interval.endedAt) ?? now;
  return Math.max(0, (end - start) / 60_000);
}

/**
 * The windows of a day. Days recorded before the windows existed only have
 * the first start and the last close, so that span is used for them: their
 * figure does not change, it just stops growing.
 */
export function intervalsOf(row: {
  teleopIntervals?: TeleopInterval[] | null;
  teleopStartedAt: string | null;
  teleopEndedAt: string | null;
}): TeleopInterval[] {
  const stored = row.teleopIntervals ?? [];
  if (stored.length) return stored;
  if (!row.teleopStartedAt) return [];
  return [{ startedAt: row.teleopStartedAt, endedAt: row.teleopEndedAt }];
}

/** Sum of the teleoperation windows in minutes; an open window counts up to now. */
export function teleopMinutes(
  row: { teleopIntervals?: TeleopInterval[] | null; teleopStartedAt: string | null; teleopEndedAt: string | null },
  now: number = Date.now(),
): number {
  return intervalsOf(row).reduce((sum, i) => sum + windowMinutes(i, now), 0);
}

/** Sum of the downtimes written down by hand, in minutes. */
export const downtimeMinutes = (row: { downtime?: DowntimeEvent[] | null }): number =>
  (row.downtime ?? []).reduce((sum, d) => sum + Math.max(0, d.minutes), 0);

/**
 * Open a window. Called when the operator enters the recording step. An
 * already open window is kept, so a reload or a second click does not start
 * a second one.
 */
export function openInterval(intervals: TeleopInterval[], at: string): TeleopInterval[] {
  if (intervals.some((i) => !i.endedAt)) return intervals;
  return [...intervals, { startedAt: at, endedAt: null }];
}

/**
 * Close every open window. Called when the operator finishes recording,
 * uploads a dataset or closes the day. Without an open window nothing
 * changes, so closing a day twice does not add time.
 */
export function closeIntervals(intervals: TeleopInterval[], at: string): TeleopInterval[] {
  if (!intervals.some((i) => !i.endedAt)) return intervals;
  return intervals.map((i) => (i.endedAt ? i : { ...i, endedAt: at }));
}

/** True while a window of the day is open. */
export const isTeleopRunning = (intervals: TeleopInterval[]): boolean => intervals.some((i) => !i.endedAt);

/** The three figures of a block, ready for the API. */
export function blockTimes(
  row: {
    teleopIntervals?: TeleopInterval[] | null;
    teleopStartedAt: string | null;
    teleopEndedAt: string | null;
    downtime?: DowntimeEvent[] | null;
  },
  recordedSeconds: number | null,
  now: number = Date.now(),
): BlockTimes {
  const intervals = intervalsOf(row);
  return {
    teleopMinutes: Math.round(teleopMinutes(row, now)),
    teleopRunning: isTeleopRunning(intervals),
    teleopSessions: intervals.length,
    recordedSeconds: recordedSeconds == null ? null : Math.round(recordedSeconds),
    downtimeMinutes: Math.round(downtimeMinutes(row)),
  };
}
