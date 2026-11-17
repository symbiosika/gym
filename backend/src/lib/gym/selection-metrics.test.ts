/**
 * The position figures over a selection: arithmetic over what the critics
 * measured per episode, nothing judged.
 *   bun run test:local ./src/lib/gym/selection-metrics.test.ts
 */
import { describe, expect, test } from "bun:test";
import type { CriticResult, EpisodeReport } from "../critics/client";
import { aggregatePositions, positionsOf, type EpisodePositions } from "./selection-metrics";

const critic = (id: string, metrics: Record<string, unknown>, error: string | null = null): CriticResult => ({
  id,
  kind: "hard",
  weight: 0,
  score: null,
  gate: false,
  gate_below: 0,
  gate_failed: false,
  flags: [],
  metrics,
  evidence: [],
  error,
});
const episode = (hard: CriticResult[]): EpisodeReport =>
  ({ episode: 0, task: "", length: 10, duration_s: 1, hard, soft: [], keyframes: {}, error: null }) as unknown as EpisodeReport;

/** an episode as the critics report it since the per-arm keys */
const measured = (graspArm: string | null, grasps: Record<string, number[][]>, wrists: Record<string, { start: number[] | null; end: number[] | null }>) =>
  episode([
    critic("smoothness", {}),
    critic("diversity", {
      grasp_pos_m: [[9, 9, 9]],
      start_pos_m: [9, 9, 9],
      grasp_arm: graspArm,
      grasps_by_arm: Object.fromEntries(Object.entries(grasps).map(([arm, g]) => [arm, { grasp_pos_m: g, release_pos_m: [] }])),
      wrists: Object.fromEntries(Object.entries(wrists).map(([arm, w]) => [arm, { start_pos_m: w.start, end_pos_m: w.end }])),
    }),
  ]);

describe("positionsOf", () => {
  test("an episode with the per-arm keys: the grasps of the arm that grasped, both wrists", () => {
    const p = positionsOf(measured("left", { left: [[0.1, 0.2, 0.3]], right: [] }, { left: { start: [0, 0, 0.5], end: [0.1, 0, 0.5] }, right: { start: [0, 0.4, 0.5], end: null } }));
    expect(p).toEqual({
      measured: true,
      graspArm: "left",
      grasps: [[0.1, 0.2, 0.3]],
      wrists: { left: { start: [0, 0, 0.5], end: [0.1, 0, 0.5] }, right: { start: [0, 0.4, 0.5], end: null } },
    });
  });

  test("an episode without a grasp still has its wrists", () => {
    const p = positionsOf(measured(null, { left: [] }, { left: { start: [0, 0, 0], end: [0, 0, 0.1] } }));
    expect(p.measured).toBe(true);
    expect(p.graspArm).toBeNull();
    expect(p.grasps).toEqual([]);
    expect(p.wrists.left!.end).toEqual([0, 0, 0.1]);
  });

  test("a report from before the per-arm keys: what it has, marked as not measured per arm", () => {
    const old = episode([critic("diversity", { wrist_feature: "observation.state.arm", grasp_pos_m: [[0.1, 0.2, 0.3]], start_pos_m: [0.3, 0.1, 0.9] })]);
    expect(positionsOf(old)).toEqual({ measured: false, graspArm: null, grasps: [[0.1, 0.2, 0.3]], wrists: {} });
  });

  test("one arm without a side in its name: no arm to name, so the grasps the critics report for the run's arm are taken", () => {
    const single = episode([critic("diversity", { grasp_pos_m: [[0.1, 0.2, 0.3]], start_pos_m: [0.3, 0.1, 0.9], wrists: {}, grasps_by_arm: {}, grasp_arm: null })]);
    // counted as without positions per arm: the reader sees that the per-arm lines have no base here
    expect(positionsOf(single)).toEqual({ measured: false, graspArm: null, grasps: [[0.1, 0.2, 0.3]], wrists: {} });
  });

  test("no diversity result, a failed one, or values that are not positions: nothing, and no throw", () => {
    const nothing = { measured: false, graspArm: null, grasps: [], wrists: {} };
    expect(positionsOf(episode([critic("smoothness", {})]))).toEqual(nothing);
    expect(positionsOf(episode([critic("diversity", {}, "no cartesian wrist state (diversity needs xyz)")]))).toEqual(nothing);
    expect(positionsOf(episode([]))).toEqual(nothing);
    const broken = positionsOf(episode([critic("diversity", { grasp_arm: 7, grasps_by_arm: "x", wrists: { left: { start_pos_m: [1, 2], end_pos_m: "no" } }, grasp_pos_m: [[1, "a", 3], null] })]));
    expect(broken.grasps).toEqual([]);
    expect(broken.wrists).toEqual({ left: { start: null, end: null } });
    expect(broken.graspArm).toBeNull();
  });
});

describe("aggregatePositions", () => {
  const at = (graspArm: string | null, grasps: number[][], wrists: EpisodePositions["wrists"] = {}, isMeasured = true): EpisodePositions => ({
    measured: isMeasured,
    graspArm,
    grasps: grasps as [number, number, number][],
    wrists,
  });

  test("pick positions: mean and population std per axis in cm, overall and per arm", () => {
    const m = aggregatePositions([at("left", [[0, 0, 0]]), at("left", [[0.02, 0, 0]]), at("right", [[0.04, 0.1, 0]])], 2);
    expect(m.datasets).toBe(2);
    expect(m.episodes).toBe(3);
    expect(m.pick.byArm.left).toEqual({ n: 2, meanCm: [1, 0, 0], stdCm: [1, 0, 0] });
    expect(m.pick.byArm.right).toEqual({ n: 1, meanCm: [4, 10, 0], stdCm: [0, 0, 0] });
    expect(m.pick.all!.n).toBe(3);
    expect(m.pick.all!.meanCm).toEqual([2, 3.33, 0]);
    expect(m.pick.all!.stdCm).toEqual([1.63, 4.71, 0]);
  });

  test("wrists per arm, and the delta left minus right only where an episode has both", () => {
    const m = aggregatePositions(
      [
        at(null, [], { left: { start: [0.1, 0, 0], end: [0.2, 0, 0] }, right: { start: [0.3, 0, 0], end: [0.3, 0, 0] } }),
        at(null, [], { left: { start: [0.3, 0, 0], end: null } }),
      ],
      1,
    );
    expect(m.wristStart.left).toEqual({ n: 2, meanCm: [20, 0, 0], stdCm: [10, 0, 0] });
    expect(m.wristStart.right).toEqual({ n: 1, meanCm: [30, 0, 0], stdCm: [0, 0, 0] });
    expect(m.wristEnd.left!.n).toBe(1);
    expect(m.deltaStart).toEqual({ n: 1, meanCm: [-20, 0, 0], stdCm: [0, 0, 0] });
    expect(m.deltaEnd).toEqual({ n: 1, meanCm: [-10, 0, 0], stdCm: [0, 0, 0] });
  });

  test("grasps of an older report count for the overall figure, under no arm, and the episode is counted as without positions per arm", () => {
    const m = aggregatePositions([at("left", [[0, 0, 0]]), at(null, [[0.02, 0, 0]], {}, false)], 1);
    expect(m.episodes).toBe(2);
    expect(m.withoutPositions).toBe(1);
    expect(m.pick.all!.n).toBe(2);
    expect(Object.keys(m.pick.byArm)).toEqual(["left"]);
  });

  test("nothing selected: no figures, and nothing divided by zero", () => {
    expect(aggregatePositions([], 0)).toEqual({
      datasets: 0,
      episodes: 0,
      withoutPositions: 0,
      pick: { all: null, byArm: {} },
      wristStart: {},
      wristEnd: {},
      deltaStart: null,
      deltaEnd: null,
    });
  });

  test("a robot without a left and a right has no delta", () => {
    const m = aggregatePositions([at(null, [], { arm: { start: [0, 0, 0], end: [0, 0, 0] } })], 1);
    expect(m.deltaStart).toBeNull();
    expect(Object.keys(m.wristStart)).toEqual(["arm"]);
  });
});
