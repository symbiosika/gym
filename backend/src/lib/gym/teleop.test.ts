/**
 * The time figures of a day.
 *   bun run test:local ./src/lib/gym/teleop.test.ts
 */
import { describe, expect, test } from "bun:test";
import { closeIntervals, blockTimes, downtimeMinutes, intervalsOf, isTeleopRunning, openInterval, teleopMinutes } from "./teleop";

const at = (minutes: number) => new Date(Date.UTC(2026, 8, 8, 8, minutes)).toISOString();
const NOW = new Date(Date.UTC(2026, 8, 8, 12, 0)).getTime();

const day = (intervals: { startedAt: string; endedAt: string | null }[]) => ({
  teleopIntervals: intervals,
  teleopStartedAt: intervals[0]?.startedAt ?? null,
  teleopEndedAt: intervals[intervals.length - 1]?.endedAt ?? null,
});

describe("teleoperation windows", () => {
  test("the time is the sum of the windows, not the span from the first start", () => {
    // 30 min of work, a two hour break, 30 min of work: 60 min, not 180
    const row = day([
      { startedAt: at(0), endedAt: at(30) },
      { startedAt: at(150), endedAt: at(180) },
    ]);
    expect(teleopMinutes(row, NOW)).toBe(60);
  });

  test("closing the day again does not add time", () => {
    const first = closeIntervals([{ startedAt: at(0), endedAt: null }], at(30));
    const second = closeIntervals(first, at(200));
    expect(second).toEqual(first);
    expect(teleopMinutes(day(second), NOW)).toBe(30);
  });

  test("a second start opens a second window, entering the step again does not", () => {
    let intervals = openInterval([], at(0));
    expect(intervals).toHaveLength(1);
    intervals = openInterval(intervals, at(5));
    expect(intervals).toHaveLength(1);
    expect(isTeleopRunning(intervals)).toBe(true);

    intervals = closeIntervals(intervals, at(30));
    expect(isTeleopRunning(intervals)).toBe(false);
    intervals = openInterval(intervals, at(150));
    expect(intervals).toHaveLength(2);
    expect(isTeleopRunning(intervals)).toBe(true);
  });

  test("an open window counts up to now", () => {
    const row = day([{ startedAt: at(0), endedAt: null }]);
    // 08:00 to 12:00
    expect(teleopMinutes(row, NOW)).toBe(240);
    expect(blockTimes(row, null, NOW).teleopRunning).toBe(true);
  });

  test("days without windows fall back to their one span", () => {
    const row = { teleopIntervals: [], teleopStartedAt: at(0), teleopEndedAt: at(45) };
    expect(intervalsOf(row)).toEqual([{ startedAt: at(0), endedAt: at(45) }]);
    expect(teleopMinutes(row, NOW)).toBe(45);
  });

  test("a day that never started has no time at all", () => {
    const row = { teleopIntervals: [], teleopStartedAt: null, teleopEndedAt: null };
    expect(teleopMinutes(row, NOW)).toBe(0);
    expect(blockTimes(row, null, NOW).teleopRunning).toBe(false);
  });

  test("naive database timestamps are read as UTC, not as local time", () => {
    // what the driver hands back for a `timestamp without time zone` column
    const row = { teleopIntervals: [{ startedAt: "2026-09-08 08:00:00.000", endedAt: "2026-09-08 08:30:00.000" }], teleopStartedAt: null, teleopEndedAt: null };
    expect(teleopMinutes(row, NOW)).toBe(30);
  });

  test("a window that ends before it starts counts zero, never negative", () => {
    const row = day([{ startedAt: at(60), endedAt: at(30) }]);
    expect(teleopMinutes(row, NOW)).toBe(0);
  });
});

describe("downtime", () => {
  const event = (minutes: number) => ({ id: "x", reason: "jam", minutes, at: at(0), createdBy: null, createdByName: "", createdAt: at(0) });

  test("the downtimes are summed", () => {
    expect(downtimeMinutes({ downtime: [event(25), event(10)] })).toBe(35);
    expect(downtimeMinutes({ downtime: [] })).toBe(0);
    expect(downtimeMinutes({})).toBe(0);
  });

  test("the three figures of a day are kept apart", () => {
    const row = { ...day([{ startedAt: at(0), endedAt: at(120) }]), downtime: [event(25)] };
    const times = blockTimes(row, 812.4, NOW);
    // the tool saw two hours, the data holds 13.5 minutes of motion, 25 minutes stood still
    expect(times).toEqual({ teleopMinutes: 120, teleopRunning: false, teleopSessions: 1, recordedSeconds: 812, downtimeMinutes: 25 });
  });
});
