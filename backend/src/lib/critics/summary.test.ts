/**
 * The summary GYM derives from a real critics run (fixtures of lerobot-critics
 * on its synthetic test dataset: four episodes, two accepted, two rejected).
 *   bun run test:local ./src/lib/critics/summary.test.ts
 */
import { describe, expect, test } from "bun:test";
import type { DatasetReport } from "./client";

type EpisodeReport = DatasetReport["episodes"][number];
import { fixtureReport, fixtureSelection } from "./fake-server.test-util";
import { defaultSelected, episodeRows, summarize } from "./summary";

describe("critics summary", () => {
  const report = fixtureReport();
  const selection = fixtureSelection();

  test("mirrors counts, lists, flags and the session profile", () => {
    const s = summarize("job_x", report, selection);
    expect(s.jobId).toBe("job_x");
    expect(s.episodes).toBe(4);
    expect(s.counts).toEqual({ accept: 2, review: 0, reject: 2 });
    expect(s.acceptRatePercent).toBe(50);
    expect(s.include).toEqual([0, 1]);
    expect(s.exclude).toEqual([2, 3]);
    expect(s.ranges.accept).toBe("0-1");
    expect(s.flagCounts.map((f) => f.flag)).toEqual(expect.arrayContaining(["LAGGY", "NOGRASP", "ACTION_SPIKES"]));
    expect(s.datasetFlags.map((f) => f.flag)).toContain("LOW_DIVERSITY");
    expect(s.profile.length).toBeGreaterThan(5);
    expect(s.profile.every((i) => !("series" in i))).toBe(true);
    expect(s.profileHeadline).toContain("indicator");
    expect(s.robotType).toBe("test_bot");
    expect(s.fps).toBe(10);
    expect(s.medianDurationSeconds).toBeGreaterThan(5);
    expect(s.softCriticsRan).toBe(false);
  });

  test("a vision-language model that did not answer is a failure, not a quiet run", () => {
    // the fixture is a real run whose VLM could not be imported: the hard
    // critics carried it, so the job is "done" although nothing was judged
    const s = summarize("job_x", report, selection);
    expect(s.softCriticsRequested).toBe(true);
    expect(s.softCriticsFailed).toBe(true);
    expect(s.softCriticsFailedEpisodes).toBe(4);
    expect(s.softCriticsError).toContain("No module named");
    // the episode rows carry it too, so the table can show why
    expect(episodeRows(report, selection)[0]!.error).toContain("No module named");
  });

  test("a run that never wanted the model is not reported as failed", () => {
    const off: DatasetReport = { ...report, spec: { ...report.spec, soft_critics: { enabled: false } }, episodes: (report.episodes as EpisodeReport[]).map((e) => ({ ...e, soft: [] })) };
    const s = summarize("job_x", off, selection);
    expect(s.softCriticsRequested).toBe(false);
    expect(s.softCriticsFailed).toBe(false);
    expect(s.softCriticsFailedEpisodes).toBe(0);
    expect(s.softCriticsError).toBeNull();
  });

  test("a model that answered is neither failed nor silent", () => {
    const ok: DatasetReport = {
      ...report,
      episodes: (report.episodes as EpisodeReport[]).map((e) => ({ ...e, soft: [{ ...e.soft[0]!, score: 0.8, error: null }] })),
    };
    const s = summarize("job_x", ok, selection);
    expect(s.softCriticsRan).toBe(true);
    expect(s.softCriticsRequested).toBe(true);
    expect(s.softCriticsFailed).toBe(false);
  });

  test("one row per episode with verdict, scores, flags and the reason", () => {
    const rows = episodeRows(report, selection);
    expect(rows.map((r) => r.index)).toEqual([0, 1, 2, 3]);
    expect(rows[0]!.verdict).toBe("accept");
    expect(rows[0]!.reason).toBeNull();
    expect(rows[0]!.totalScore).toBe(1);
    expect(rows[0]!.criticScores.integrity).toBe(1);
    expect(rows[2]!.verdict).toBe("reject");
    expect(rows[2]!.flags).toEqual(expect.arrayContaining(["LAGGY"]));
    expect(rows[2]!.reason?.cause).toBe("gate");
    expect(rows[2]!.reason?.blocking).toEqual(["LAGGY"]);
    expect(rows[2]!.reason?.why).toContain("duplication");
    expect(rows[3]!.reason?.blocking).toEqual(["NOGRASP"]);
    expect(rows[3]!.frames).toBe(60);
    expect(rows[3]!.durationSeconds).toBe(6);
  });

  test("only rejected episodes start deselected", () => {
    expect(defaultSelected("accept")).toBe(true);
    expect(defaultSelected("review")).toBe(true);
    expect(defaultSelected("reject")).toBe(false);
  });
});
