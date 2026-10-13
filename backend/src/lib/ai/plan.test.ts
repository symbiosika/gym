/**
 * The deterministic parts of the AI layer: fallbacks and normalisation.
 *   bun run test:local ./src/lib/ai/plan.test.ts
 */
import { describe, expect, test } from "bun:test";
import { fallbackFollowUp, fallbackPlan, normalisePlan, plainPlan, planEpisodes } from "./plan";
import type { CriticsSummary } from "../critics/summary";

const analysis = (episodes: number, accepted: number): CriticsSummary => ({
  jobId: "job",
  datasetName: "ds",
  specName: "auto",
  robotType: "test_bot",
  fps: 30,
  cameras: [],
  episodes,
  counts: { accept: accepted, review: 0, reject: episodes - accepted },
  acceptRatePercent: (accepted / episodes) * 100,
  include: [],
  review: [],
  exclude: [],
  ranges: {},
  flagCounts: [],
  datasetFlags: [],
  rawFlagCounts: [],
  version: 2,
  overrides: { ignoreFlags: [], reviewFlags: [], disabledCritics: [] },
  critics: [],
  switchable: [],
  profileHeadline: "",
  profile: [],
  medianDurationSeconds: 15,
  totalDurationSeconds: 0,
  acceptedDurationSeconds: 0,
  timingSeconds: null,
  softCriticsRan: false,
  softCriticsRequested: false,
  softCriticsFailed: false,
  softCriticsFailedEpisodes: 0,
  softCriticsError: null,
  createdAt: new Date().toISOString(),
});

describe("plan fallbacks", () => {
  test("fallback plan hits the target exactly", () => {
    for (const target of [1, 7, 200, 333]) {
      const plan = fallbackPlan({ cellName: "Cell 13", taskDescription: "cup to tray", sceneText: "", targetEpisodes: target, language: "de" });
      expect(planEpisodes(plan)).toBe(target);
      expect(plan.source).toBe("fallback");
      expect(plan.steps[0]!.variations.length).toBeGreaterThan(0);
      for (const s of plan.steps) expect(s.id).toMatch(/^step-/);
    }
  });

  test("the plain plan is the target on the task, in one step", () => {
    const plan = plainPlan({ cellName: "Cell 13", taskDescription: "cup to tray", sceneText: "cup left, tray right", targetEpisodes: 12, language: "de" });
    expect(plan.source).toBe("plain");
    expect(planEpisodes(plan)).toBe(12);
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]!.variations).toHaveLength(1);
    // today's scene text is the task of the block, the skill's task is the instruction next to it
    expect(plan.steps[0]!.variations[0]!.label).toBe("cup left, tray right");
    expect(plan.steps[0]!.instructions).toBe("cup to tray");
    expect(plan.sceneSetup).toEqual([]);
    expect(plan.randomizations).toEqual([]);

    // without a scene text the skill's task carries the block
    const fromSkill = plainPlan({ cellName: "Cell 13", taskDescription: "cup to tray", sceneText: "", targetEpisodes: 3, language: "en" });
    expect(fromSkill.steps[0]!.variations[0]!.label).toBe("cup to tray");
    expect(fromSkill.steps[0]!.instructions).toBe("");
  });

  test("normalisation drops empty variations and steps", () => {
    const plan = normalisePlan(
      {
        summary: " s ",
        sceneSetup: ["a", " "],
        randomizations: [],
        steps: [
          { title: "keep", instructions: "", variations: [{ label: "x", episodes: 3 }, { label: "", episodes: 5 }] },
          { title: "drop", instructions: "", variations: [{ label: "y", episodes: 0 }] },
        ],
      },
      "ai",
    );
    expect(plan.summary).toBe("s");
    expect(plan.sceneSetup).toEqual(["a"]);
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]!.episodes).toBe(3);
  });

  test("follow-up fallback asks for the missing good episodes", () => {
    const f = fallbackFollowUp({ language: "en", targetEpisodes: 100, plan: null, analyses: [analysis(80, 60)] });
    expect(f.items[0]!.episodes).toBe(40);
    const done = fallbackFollowUp({ language: "en", targetEpisodes: 50, plan: null, analyses: [analysis(60, 55)] });
    expect(done.items).toHaveLength(0);
  });
});
