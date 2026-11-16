/**
 * The position figures over a selection of episodes: where the robot picked,
 * and where its wrists were at the start and at the end.
 *
 * GYM measures nothing here. The data critics report the positions per
 * episode (their `diversity` critic: `grasps_by_arm`, `grasp_arm`, `wrists`),
 * and this module only does the arithmetic over the episodes a person
 * selected: a mean, a standard deviation and a count per axis. No threshold,
 * no flag, no verdict: what a spread means is the reader's to say, or the
 * critics' (`LOW_DIVERSITY`), never GYM's.
 *
 * The standard deviation is the population one (divided by n), as the critics
 * use it in their run summary, so the two can be read side by side.
 *
 * A report from before the per-arm keys carries the grasp positions of one arm
 * and no wrists per arm, and so does a robot with one arm whose features name
 * no side. Such an episode adds what it has to the overall pick figure and is
 * counted in `withoutPositions`, so the reader sees the base.
 */
import type { EpisodeReport } from "../critics/client";

export type Xyz = [number, number, number];

/** A mean and a spread per axis (x, y, z) in centimetres over `n` positions. */
export interface AxisStat {
  n: number;
  meanCm: Xyz;
  stdCm: Xyz;
}

/** What the critics measured in one episode, as far as the figures need it. Positions in metres. */
export interface EpisodePositions {
  /** false for a report from before the per-arm keys, or without a diversity result */
  measured: boolean;
  /** the arm that grasped; null without a grasp, on one arm without a side, or in an older report */
  graspArm: string | null;
  grasps: Xyz[];
  wrists: Record<string, { start: Xyz | null; end: Xyz | null }>;
}

export interface SelectionMetrics {
  /** datasets and episodes the figures are taken over */
  datasets: number;
  episodes: number;
  /** episodes among them whose report has no positions per arm */
  withoutPositions: number;
  pick: { all: AxisStat | null; byArm: Record<string, AxisStat> };
  wristStart: Record<string, AxisStat>;
  wristEnd: Record<string, AxisStat>;
  /** left minus right, over the episodes where both have a position */
  deltaStart: AxisStat | null;
  deltaEnd: AxisStat | null;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** A position as the critics write it: three finite numbers. Anything else is no position. */
const xyz = (value: unknown): Xyz | null =>
  Array.isArray(value) && value.length === 3 && value.every((n) => typeof n === "number" && Number.isFinite(n)) ? (value as Xyz) : null;

const xyzList = (value: unknown): Xyz[] => (Array.isArray(value) ? value.map(xyz).filter((p): p is Xyz => p !== null) : []);

/** The positions of one episode of a critics report. Never throws: a report is mirrored as it is and may be of any age. */
export function positionsOf(ep: EpisodeReport): EpisodePositions {
  const result = (ep.hard ?? []).find((c) => c.id === "diversity");
  const m = result && !result.error && isObject(result.metrics) ? result.metrics : null;
  if (!m) return { measured: false, graspArm: null, grasps: [], wrists: {} };
  if (!isObject(m.wrists)) {
    // before the per-arm keys: the grasps of the one arm the spec followed
    return { measured: false, graspArm: null, grasps: xyzList(m.grasp_pos_m), wrists: {} };
  }
  const wrists: EpisodePositions["wrists"] = {};
  for (const [arm, w] of Object.entries(m.wrists)) {
    if (isObject(w)) wrists[arm] = { start: xyz(w.start_pos_m), end: xyz(w.end_pos_m) };
  }
  if (!Object.keys(wrists).length) {
    // one arm whose features carry no side: the critics have no arm to name, and the grasps
    // they report for the arm of the run are the ones there are
    return { measured: false, graspArm: null, grasps: xyzList(m.grasp_pos_m), wrists: {} };
  }
  const graspArm = typeof m.grasp_arm === "string" && m.grasp_arm ? m.grasp_arm : null;
  const byArm = isObject(m.grasps_by_arm) ? m.grasps_by_arm[graspArm ?? ""] : null;
  return { measured: true, graspArm, grasps: isObject(byArm) ? xyzList(byArm.grasp_pos_m) : [], wrists };
}

const round2 = (n: number) => Math.round(n * 100) / 100 + 0; // + 0: no negative zero in the answer

/** Mean and population standard deviation per axis, in centimetres, of positions in metres. Null without any. */
function stat(points: Xyz[]): AxisStat | null {
  if (!points.length) return null;
  const axis = (k: 0 | 1 | 2) => {
    const values = points.map((p) => p[k] * 100);
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
    return [round2(mean), round2(Math.sqrt(variance))] as const;
  };
  const [x, y, z] = [axis(0), axis(1), axis(2)];
  return { n: points.length, meanCm: [x[0], y[0], z[0]], stdCm: [x[1], y[1], z[1]] };
}

/** One figure per key that has any position. */
function statsByKey(groups: Map<string, Xyz[]>): Record<string, AxisStat> {
  const out: Record<string, AxisStat> = {};
  for (const [key, points] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const s = stat(points);
    if (s) out[key] = s;
  }
  return out;
}

const push = (groups: Map<string, Xyz[]>, key: string, point: Xyz) => groups.set(key, [...(groups.get(key) ?? []), point]);
const minus = (a: Xyz, b: Xyz): Xyz => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

/** The figures over a list of episodes from `datasets` datasets. */
export function aggregatePositions(list: EpisodePositions[], datasets: number): SelectionMetrics {
  const picks: Xyz[] = [];
  const picksByArm = new Map<string, Xyz[]>();
  const starts = new Map<string, Xyz[]>();
  const ends = new Map<string, Xyz[]>();
  const deltaStart: Xyz[] = [];
  const deltaEnd: Xyz[] = [];
  for (const ep of list) {
    for (const g of ep.grasps) {
      picks.push(g);
      if (ep.graspArm) push(picksByArm, ep.graspArm, g);
    }
    for (const [arm, w] of Object.entries(ep.wrists)) {
      if (w.start) push(starts, arm, w.start);
      if (w.end) push(ends, arm, w.end);
    }
    const { left, right } = ep.wrists;
    if (left?.start && right?.start) deltaStart.push(minus(left.start, right.start));
    if (left?.end && right?.end) deltaEnd.push(minus(left.end, right.end));
  }
  return {
    datasets,
    episodes: list.length,
    withoutPositions: list.filter((ep) => !ep.measured).length,
    pick: { all: stat(picks), byArm: statsByKey(picksByArm) },
    wristStart: statsByKey(starts),
    wristEnd: statsByKey(ends),
    deltaStart: stat(deltaStart),
    deltaEnd: stat(deltaEnd),
  };
}
