/**
 * The pure parts of the evaluation figures: the Wilson interval, the mapping
 * of rollouts onto the plan's variations and the aggregation a report is
 * made of. No database.
 *   bun run test:local ./src/lib/gym/evaluations.test.ts
 */
import { describe, expect, test } from "bun:test";
import type { RecordingPlan } from "../../db/schema";
import type { CriticResult, EpisodeReport } from "../critics/client";
import { aggregate, rateOf, suggestFailureCode, variationAt, variationOptions, vlmOf, wilson, type RolloutBlockInfo, type RolloutRow, type RolloutVlm } from "./evaluations";

const plan = (steps: { title: string; variations: [string, number][] }[]): RecordingPlan => ({
  summary: "",
  sceneSetup: [],
  randomizations: [],
  steps: steps.map((s, i) => ({
    id: `s${i}`,
    title: s.title,
    instructions: "",
    variations: s.variations.map(([label, episodes]) => ({ label, episodes })),
    episodes: s.variations.reduce((a, [, n]) => a + n, 0),
  })),
  source: "manual",
  createdAt: "2026-09-15T10:00:00Z",
});

const block = (blockId: string, policyName: string | null, p: RecordingPlan | null, date = "2026-09-15"): RolloutBlockInfo => ({
  blockId,
  date,
  cellName: "Cell 13",
  policyId: policyName ? `p-${policyName}` : null,
  policyName,
  step: "closed",
  targetEpisodes: null,
  plan: p,
  vlmFailedDatasets: 0,
});

let n = 0;
const rollout = (blockId: string, over: Partial<RolloutRow>): RolloutRow => {
  n += 1;
  const verdict = over.verdict ?? over.criticsVerdict ?? "accept";
  return {
    episodeId: `e${n}`,
    blockId,
    datasetId: `d-${blockId}`,
    datasetName: `rollouts ${blockId}`,
    index: n,
    position: n,
    variation: null,
    variationSet: false,
    criticsVerdict: over.criticsVerdict ?? verdict,
    humanVerdict: null,
    verdict,
    succeeded: verdict === "accept",
    pendingReview: false,
    failureCode: null,
    invalid: false,
    note: "",
    durationSeconds: 10,
    flags: [],
    criticsReason: null,
    vlm: null,
    suggestedFailureCode: null,
    reviewedByName: "",
    reviewedAt: null,
    ...over,
  };
};

describe("vlmOf", () => {
  const critic = (over: Partial<CriticResult>): CriticResult => ({
    id: "vlm.x",
    kind: "soft",
    weight: 1,
    score: null,
    gate: false,
    gate_below: 0,
    gate_failed: false,
    flags: [],
    metrics: {},
    evidence: [],
    error: null,
    ...over,
  });
  const episode = (soft: CriticResult[]): EpisodeReport => ({ episode: 3, task: "", length: 10, duration_s: 1, hard: [], soft, score: {} as EpisodeReport["score"], keyframes: {}, error: null });

  test("the model's decision, summary, indicators with evidence and anomalies are read from the soft critics", () => {
    const v = vlmOf(
      episode([
        critic({ id: "vlm.object_in_target", score: 0.2, flags: ["VLM_OBJECT_IN_TARGET"], metrics: { confidence: 0.9 }, evidence: ["cup left on the counter at t=41s"] }),
        critic({ id: "vlm.grasp_centered", score: 1, metrics: { confidence: 0.8 }, evidence: ["centred grasp at t=12s"] }),
        critic({
          id: "vlm.summary",
          weight: 0,
          score: 0,
          flags: ["VLM_TASK_FAILED", "VLM_MAJOR_ANOMALY"],
          metrics: { task_success: false, confidence: 0.85, model: "gemini", anomalies: [{ type: "drop", time_s: 40.5, severity: "major", description: "cup slipped" }] },
          evidence: ["The cup was grasped but dropped before the zone.", "drop@40.5s (major): cup slipped"],
        }),
      ]),
    );
    expect(v).toMatchObject({ taskSuccess: false, confidence: 0.85, summary: "The cup was grasped but dropped before the zone.", model: "gemini", error: null });
    expect(v!.indicators.map((i) => [i.id, i.score, i.evidence])).toEqual([
      ["object_in_target", 0.2, "cup left on the counter at t=41s"],
      ["grasp_centered", 1, "centred grasp at t=12s"],
    ]);
    expect(v!.anomalies).toEqual([{ type: "drop", timeSeconds: 40.5, severity: "major", description: "cup slipped" }]);
    expect(v!.flags).toEqual(["VLM_OBJECT_IN_TARGET", "VLM_TASK_FAILED", "VLM_MAJOR_ANOMALY"]);
  });

  test("a model that did not answer leaves its error; a run without soft critics leaves null", () => {
    const v = vlmOf(episode([critic({ id: "vlm.summary", weight: 0, error: "RuntimeError: GEMINI_API_KEY not set" })]));
    expect(v).toMatchObject({ taskSuccess: null, summary: "", error: "RuntimeError: GEMINI_API_KEY not set" });
    expect(vlmOf(episode([]))).toBeNull();
    expect(vlmOf(undefined)).toBeNull();
  });
});

describe("suggestFailureCode", () => {
  const vlm = (anomalies: [string, number | null, string, string][], over: Partial<RolloutVlm> = {}): RolloutVlm => ({
    taskSuccess: false,
    confidence: 0.9,
    summary: "",
    indicators: [],
    anomalies: anomalies.map(([type, timeSeconds, severity, description]) => ({ type, timeSeconds, severity, description })),
    flags: [],
    model: "gemini",
    error: null,
    ...over,
  });
  const suggest = (v: RolloutVlm | null, flags: string[] = [], succeeded = false) => suggestFailureCode({ succeeded, flags, vlm: v });

  test("the first thing that went wrong decides, in time order, whatever its severity", () => {
    // a fumbled grasp, then the cup knocked over: the grasp is the cause (192-episode set, rollout 2)
    expect(
      suggest(
        vlm([
          ["object_knocked_over", 26.6, "major", "The robot hand collides with the white cup, knocking it over onto the counter."],
          ["re-grasp", 18.2, "minor", "The robot aborts its initial grasp on the orange cup and repeatedly repositions its hand."],
        ]),
      ),
    ).toBe("F-01");
    expect(suggest(vlm([["failed_grasp", 14.2, "major", "The gripper fails to secure a grasp on the white cup and slips off."], ["collision", 24.0, "major", "The robot arm collides with the orange cup."]]))).toBe("F-01");
    expect(suggest(vlm([["collision", 9.0, "major", "The arm hits the tray."], ["drop", 12.0, "major", "The cup falls."]]))).toBe("F-06");
  });

  test("the anomaly's type is read before its description", () => {
    // "attempting to grasp" in the description must not turn a freeze into a grasp failure (rollout 10)
    expect(suggest(vlm([["operator_freeze", 22.0, "major", "The teleoperation freezes completely after attempting to grasp the cup at t=22.0s."]]))).toBe("F-05");
    expect(suggest(vlm([["robot_freeze", 14.0, "major", "The robot stops all motion after contacting the cup and remains frozen."]]))).toBe("F-05");
    expect(suggest(vlm([["object_toppled", 22.0, "major", "The white cup tipped over on its side during placement on target zone R."]]))).toBe("F-03");
    expect(suggest(vlm([["drop", 15.0, "major", "The robot drops the white cup while lifting it."]]))).toBe("F-01");
    expect(suggest(vlm([["wrong_object", 5.0, "major", "The robot picks the distractor bottle."]]))).toBe("F-04");
    expect(suggest(vlm([["misalignment", 5.0, "minor", "The gripper overshoots the cup by several centimetres and closes beside it."]]))).toBe("F-02");
  });

  test("infrastructure and a person in the loop are not charged to the policy, whenever they happened", () => {
    expect(suggest(vlm([["drop", 12.8, "major", "The white cup slips from the gripper."], ["camera_freeze", 10.4, "major", "The wrist_left camera feed freezes."]]))).toBe("F-08");
    expect(suggest(vlm([["drop", 12.8, "major", "The white cup slips from the gripper."], ["human_in_workspace", 20.0, "major", "A person pushes the cup into the zone."]]))).toBe("F-08");
    // a scene reset by a person and other informational notes are not a cause
    expect(suggest(vlm([["scene_reset", 46.4, "info", "Human hands enter the workspace to reset the scene."], ["drop", 24.2, "major", "The cup slipped out of the gripper."]]))).toBe("F-01");
  });

  test("without an anomaly the flags decide; a success or nothing to go on gives no suggestion", () => {
    expect(suggest(vlm([]), ["VLM_OBJECT_IN_TARGET", "VLM_TASK_FAILED"])).toBe("F-03");
    expect(suggest(vlm([]), ["NOGRASP"])).toBe("F-01");
    expect(suggest(vlm([]), ["VLM_CORRECT_OBJECT"])).toBe("F-04");
    expect(suggest(null, ["CAMSTALL"])).toBe("F-08");
    expect(suggest(null, ["HESITATION"])).toBe("F-05");
    expect(suggest(null, [])).toBeNull();
    expect(suggest(vlm([["drop", 1, "major", "dropped"]]), [], true)).toBeNull();
    // the model's error is no anomaly
    expect(suggest(vlm([], { error: "no key" }), ["TRACKERR"])).toBe("F-08");
  });
});

describe("wilson", () => {
  test("13 of 20 reads as 65 % with an interval from 43 to 82 %", () => {
    expect(wilson(13, 20)).toEqual({ low: 43.3, high: 81.9 });
    // a perfect run is not a certain one
    expect(wilson(12, 12)).toEqual({ low: 75.8, high: 100 });
    expect(wilson(0, 5)).toEqual({ low: 0, high: 43.4 });
    expect(wilson(0, 0)).toBeNull();
  });

  test("rateOf rounds the rate to one decimal and keeps null without rollouts", () => {
    expect(rateOf(2, 3)).toMatchObject({ rollouts: 3, succeeded: 2, ratePercent: 66.7 });
    expect(rateOf(0, 0)).toMatchObject({ ratePercent: null, ci: null });
  });
});

describe("variations of the plan", () => {
  test("labels are unique across steps; the step title is prefixed only when a label repeats", () => {
    const one = plan([{ title: "Counter", variations: [["orange right", 5], ["orange left", 5]] }]);
    expect(variationOptions(one).map((o) => o.label)).toEqual(["orange right", "orange left"]);
    const two = plan([
      { title: "Near", variations: [["q1", 2], ["q2", 2]] },
      { title: "Far", variations: [["q1", 2], ["q3", 2]] },
    ]);
    expect(variationOptions(two).map((o) => o.label)).toEqual(["Near · q1", "q2", "Far · q1", "q3"]);
    expect(variationOptions(null)).toEqual([]);
  });

  test("rollouts follow the plan in order, one variation after the other; beyond the plan there is none", () => {
    const options = variationOptions(plan([{ title: "Counter", variations: [["a", 2], ["b", 1]] }]));
    expect([0, 1, 2, 3].map((i) => variationAt(options, i))).toEqual(["a", "a", "b", null]);
  });
});

describe("aggregate", () => {
  const p = plan([{ title: "Counter", variations: [["orange right", 2], ["orange left", 2]] }]);
  const b8 = block("b8", "8k", p);
  const b13 = block("b13", "13k", p);

  test("success by block, by variation, failure modes, best block and top failure", () => {
    const rollouts = [
      rollout("b8", { variation: "orange right", verdict: "accept" }),
      rollout("b8", { variation: "orange right", verdict: "reject", failureCode: "F-01" }),
      rollout("b8", { variation: "orange left", verdict: "reject", failureCode: "F-01" }),
      rollout("b8", { variation: "orange left", verdict: "reject", failureCode: "F-02" }),
      rollout("b13", { variation: "orange right", verdict: "accept" }),
      rollout("b13", { variation: "orange right", verdict: "accept" }),
      rollout("b13", { variation: "orange left", verdict: "accept" }),
      // F-08: the robot's arm was blocked; shown, but not the policy's fault
      rollout("b13", { variation: "orange left", verdict: "reject", failureCode: "F-08", invalid: true }),
    ];
    const f = aggregate([b8, b13], rollouts);
    expect(f.overall).toMatchObject({ rollouts: 8, succeeded: 4, ratePercent: 50, invalid: 1, attributableRatePercent: 57.1, pendingReview: 0 });
    expect(f.overall.failures).toEqual({ "F-01": 2, "F-02": 1, "F-08": 1 });
    expect(f.blocks.map((b) => [b.label, b.succeeded, b.rollouts, b.ratePercent])).toEqual([
      ["8k", 1, 4, 25],
      ["13k", 3, 4, 75],
    ]);
    expect(f.blocks[0]!.byVariation["orange right"]).toMatchObject({ succeeded: 1, rollouts: 2 });
    expect(f.blocks[1]!.attributableRatePercent).toBe(100);
    expect(f.variations.map((x) => [x.label, x.succeeded, x.rollouts])).toEqual([
      ["orange right", 3, 4],
      ["orange left", 1, 4],
    ]);
    expect(f.failureModes.map((x) => [x.code, x.count])).toEqual([
      ["F-01", 2],
      ["F-02", 1],
      ["F-08", 1],
    ]);
    expect(f.failureModes[0]!.perBlock).toEqual({ b8: 2 });
    expect(f.best).toEqual({ blockId: "b13", label: "13k", ratePercent: 75 });
    expect(f.topFailure).toMatchObject({ code: "F-01", count: 2 });
  });

  test("a block without rollouts stays in the report with empty figures and is never the best one", () => {
    const f = aggregate([b8, block("b11", "11k", p)], [rollout("b8", { verdict: "accept" })]);
    expect(f.blocks[1]).toMatchObject({ label: "11k", rollouts: 0, ratePercent: null, ci: null });
    expect(f.best?.blockId).toBe("b8");
    expect(f.topFailure).toBeNull();
    expect(f.variations).toEqual([]);
  });

  test("the human review counts, the critics' review verdict waits for a person", () => {
    const rollouts = [
      rollout("b8", { criticsVerdict: "reject", humanVerdict: "accept", verdict: "accept" }),
      rollout("b8", { criticsVerdict: "review", verdict: "review", pendingReview: true }),
    ];
    const f = aggregate([b8], rollouts);
    expect(f.overall).toMatchObject({ rollouts: 2, succeeded: 1, ratePercent: 50, pendingReview: 1, reviewed: 1 });
  });

  test("blocks of the same policy are told apart by their date; blocks without a policy by date and cell", () => {
    const f = aggregate([block("a", "v1", null, "2026-09-11"), block("b", "v1", null, "2026-09-14"), block("c", null, null, "2026-09-15")], []);
    expect(f.blocks.map((b) => b.label)).toEqual(["v1 · 2026-09-11", "v1 · 2026-09-14", "2026-09-15 · Cell 13"]);
  });

  test("a variation a reviewer named by hand is listed after the plan's", () => {
    const f = aggregate([b8], [rollout("b8", { variation: "orange right" }), rollout("b8", { variation: "white left", variationSet: true })]);
    expect(f.variations.map((x) => x.label)).toEqual(["orange right", "white left"]);
  });
});
