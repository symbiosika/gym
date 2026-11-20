/**
 * Prompts and shortcuts: the prompt check of a dataset against the skill's
 * other datasets, corrected prompts and paraphrases in the exports, and the
 * shortcut figures over the selection with the evaluation's rollouts beside it.
 *   bun run test:local ./src/routes/tenant/[tenantId]/gym/prompts.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { and, asc, eq } from "drizzle-orm";
import type { SymbiosikaFrameworkHonoApp } from "@framework/types";
import { initTests, TEST_ORGANISATION_1 } from "@framework/test/init.test";
import { testFetcher } from "@framework/test/fetcher.test";
import { getDb } from "@framework/lib/db/db-connection";
import { defineFilesRoutes } from "@framework/routes/tenant/[tenantId]/files";
import { _GLOBAL_SERVER_CONFIG } from "@framework/store";
import { cells, datasets, dayProtocols, episodes, exports, skills } from "../../../../db/schema";
import type { DatasetReport } from "../../../../lib/critics/client";
import { startFakeCritics, type FakeCritics } from "../../../../lib/critics/fake-server.test-util";
import defineGymRoutes from "./index";

let app: SymbiosikaFrameworkHonoApp;
let token: string;
let token2: string;
let critics: FakeCritics;
let server: ReturnType<typeof Bun.serve>;
let originalBaseUrl = "";
let originalBasePath = "";
const T = TEST_ORGANISATION_1.id;
const base = `/tenant/${T}/gym`;
const RED = "put the red block in the box";

const cleanup = async () => {
  const db = getDb();
  await db.delete(skills).where(eq(skills.tenantId, T));
  await db.delete(dayProtocols).where(eq(dayProtocols.tenantId, T));
  await db.delete(cells).where(eq(cells.tenantId, T));
};

const zipUpload = (fileName: string) => {
  const form = new FormData();
  form.append("file", new File([new Blob([new Uint8Array([0x50, 0x4b, 3, 4, 1, 2, 3])])], fileName, { type: "application/zip" }));
  return form;
};

/** The features the critics write since the shortcut figures (the fixture is a report of before). */
async function giveFeatures(datasetId: string) {
  const [row] = await getDb().select({ report: datasets.report }).from(datasets).where(eq(datasets.id, datasetId));
  const report = row!.report as DatasetReport;
  for (const ep of report.episodes) {
    const div = ep.hard.find((c) => c.id === "diversity");
    if (div) div.metrics = { ...div.metrics, cue_features: { prompt: ep.task, start_state: [ep.episode, 0, 1], look: [0.1, 0.2] } };
  }
  await getDb().update(datasets).set({ report }).where(eq(datasets.id, datasetId));
}

const episodesOf = (datasetId: string) => getDb().select().from(episodes).where(eq(episodes.datasetId, datasetId)).orderBy(asc(episodes.index));

describe("Prompts and shortcuts", () => {
  let skillId = "";
  let cellId = "";
  let blockId = "";
  let dsA = "";
  let dsB = "";
  const actions = async () => ((await testFetcher.get(app, `${base}/skills/${skillId}/audit`, token)).jsonResponse as { action: string }[]).map((a) => a.action);

  beforeAll(async () => {
    const tokens = await initTests();
    token = tokens.user1Token;
    token2 = tokens.user2Token;
    app = new Hono();
    defineGymRoutes(app);
    defineFilesRoutes(app, "");
    server = Bun.serve({ port: 0, fetch: (request) => app.fetch(request) });
    originalBaseUrl = _GLOBAL_SERVER_CONFIG.baseUrl;
    originalBasePath = _GLOBAL_SERVER_CONFIG.basePath;
    _GLOBAL_SERVER_CONFIG.baseUrl = `http://127.0.0.1:${server.port}`;
    _GLOBAL_SERVER_CONFIG.basePath = "";
    critics = startFakeCritics();
    process.env.CRITICS_URL = critics.url;
    await cleanup();
    cellId = (await testFetcher.post(app, `${base}/cells`, token, { name: "Prompt cell" })).jsonResponse.id;
    skillId = (await testFetcher.post(app, `${base}/skills`, token, { name: "Pick from shelf" })).jsonResponse.id;
    blockId = (await testFetcher.post(app, `${base}/blocks`, token, { cellId, skillId, kind: "recording", date: "2026-11-16" })).jsonResponse.block.id;
    dsA = (await testFetcher.postFormData(app, `${base}/blocks/${blockId}/datasets`, token, zipUpload("shelf_a.zip"))).jsonResponse.id;
    dsB = (await testFetcher.postFormData(app, `${base}/blocks/${blockId}/datasets`, token, zipUpload("shelf_b.zip"))).jsonResponse.id;
    // reading the block syncs the runs: four episodes each, 0 and 1 accepted and selected, 2 and 3 rejected
    const block = await testFetcher.get(app, `${base}/blocks/${blockId}`, token);
    expect(block.jsonResponse.datasets.map((d: { analysisStatus: string }) => d.analysisStatus)).toEqual(["done", "done"]);
    await giveFeatures(dsA);
    await giveFeatures(dsB);
    // dataset B was recorded under a stand-in prompt for its first episode
    await getDb().update(episodes).set({ task: "wrong prompt" }).where(and(eq(episodes.datasetId, dsB), eq(episodes.index, 0)));
  });

  afterAll(async () => {
    critics.stop();
    server?.stop(true);
    _GLOBAL_SERVER_CONFIG.baseUrl = originalBaseUrl;
    _GLOBAL_SERVER_CONFIG.basePath = originalBasePath;
    delete process.env.CRITICS_URL;
    await cleanup().catch((error) => console.warn("afterAll cleanup failed:", error));
  });

  test("the prompt check hands the dataset and the skill's other datasets to the critics and shows their word", async () => {
    const res = await testFetcher.get(app, `${base}/datasets/${dsB}/prompts`, token);
    expect(res.status).toBe(200);
    const view = res.jsonResponse;
    expect(view.mode).toBe("reference");
    expect(view.episodes).toHaveLength(4);
    expect(view.episodes[0]).toMatchObject({ index: 0, task: "wrong prompt", promptOverride: null, prompt: "wrong prompt", status: "propose", proposed: RED });
    expect(view.episodes[1]).toMatchObject({ index: 1, status: "ok", proposed: null });
    expect(view.counts).toEqual({ propose: 1, ok: 3 });
    expect(view.candidates).toContain(RED);

    const call = critics.analyses.at(-1)!;
    expect(call.path).toBe("/analyses/prompts");
    expect(call.body.episodes.map((e) => e.dataset)).toEqual([dsB, dsB, dsB, dsB]);
    expect(call.body.episodes[0]!.metrics).toHaveProperty("cue_features");
    // the reference is the other dataset, without what was rejected
    const aEps = await episodesOf(dsA);
    expect(call.body.reference!.map((e) => e.id).sort()).toEqual(aEps.filter((e) => e.verdict !== "reject").map((e) => e.id).sort());

    expect((await testFetcher.get(app, `${base}/datasets/${dsB}/prompts`, undefined)).status).toBe(401);
    expect((await testFetcher.get(app, `${base}/datasets/${dsB}/prompts`, token2)).status).toBe(403);
  });

  test("a person sets a prompt; the recorded one stays, giving it back clears the correction", async () => {
    const res = await testFetcher.put(app, `${base}/datasets/${dsB}/prompts`, token, { episodes: [{ index: 0, prompt: RED }, { index: 1, prompt: RED }] });
    expect(res.status).toBe(200);
    // episode 1 already carries that prompt: nothing to correct
    expect(res.jsonResponse.changed).toBe(1);
    let rows = await episodesOf(dsB);
    expect(rows[0]).toMatchObject({ task: "wrong prompt", promptOverride: RED });
    expect(rows[1]!.promptOverride).toBeNull();
    expect(await actions()).toContain("dataset.prompts");

    // the check counts with the corrected prompt now
    const view = (await testFetcher.get(app, `${base}/datasets/${dsB}/prompts`, token)).jsonResponse;
    expect(view.episodes[0]).toMatchObject({ prompt: RED, promptOverride: RED, status: "ok" });

    await testFetcher.put(app, `${base}/datasets/${dsB}/prompts`, token, { episodes: [{ index: 0, prompt: null }] });
    rows = await episodesOf(dsB);
    expect(rows[0]!.promptOverride).toBeNull();
    await testFetcher.put(app, `${base}/datasets/${dsB}/prompts`, token, { episodes: [{ index: 0, prompt: RED }] });

    expect((await testFetcher.put(app, `${base}/datasets/${dsB}/prompts`, token, { episodes: [{ index: 9, prompt: RED }] })).status).toBe(400);
    expect((await testFetcher.put(app, `${base}/datasets/${dsB}/prompts`, token, { episodes: [{ index: "x" }] })).status).toBe(400);
  });

  test("paraphrases are the skill's: empty lists are dropped, the prompt itself never counts as its own variant", async () => {
    const res = await testFetcher.put(app, `${base}/skills/${skillId}/prompt-variants`, token, {
      [RED]: { variants: ["place the red block into the box", RED, "place the red block into the box"], keepOriginal: true },
      "pick nothing": { variants: [], keepOriginal: true },
    });
    expect(res.status).toBe(200);
    expect(res.jsonResponse).toEqual({ [RED]: { variants: ["place the red block into the box"], keepOriginal: true } });
    const skill = (await testFetcher.get(app, `${base}/skills/${skillId}`, token)).jsonResponse;
    expect(skill.promptVariants).toEqual(res.jsonResponse);
    expect(await actions()).toContain("skill.prompt_variants");
    expect((await testFetcher.put(app, `${base}/skills/${skillId}/prompt-variants`, token, { [RED]: { variants: "x" } })).status).toBe(400);
  });

  test("the merged export writes the corrected prompts and spreads the paraphrases evenly; the light export lists them", async () => {
    const res = await app.request(`${base}/skills/${skillId}/exports/dataset`, {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: "with prompts" }),
    });
    expect(res.status).toBe(200);
    await res.arrayBuffer();
    const merge = critics.merges.at(-1)!;
    // selected: episodes 0 and 1 of A, then 0 and 1 of B, all counting as RED now; in turn RED, variant, RED, variant
    expect(merge.sources.map((s) => s.prompts ?? {})).toEqual([{ "1": "place the red block into the box" }, { "0": RED, "1": "place the red block into the box" }]);
    const [record] = await getDb().select().from(exports).where(eq(exports.skillId, skillId));
    expect(record!.selection.datasets[1]!.prompts).toEqual({ "0": RED, "1": "place the red block into the box" });

    // the unfiltered download of a dataset carries the corrections, not the paraphrases
    const raw = await app.request(`${base}/datasets/${dsB}/export-unfiltered`, { method: "POST", headers: { Authorization: `Bearer ${token}` } });
    expect(raw.status).toBe(200);
    await raw.arrayBuffer();
    expect(critics.merges.at(-1)!.sources[0]!.prompts).toEqual({ "0": RED });
  });

  test("the shortcut figures go to the critics with the selected episodes, their prompts now and the evaluation's rollouts", async () => {
    const res = await testFetcher.get(app, `${base}/skills/${skillId}/selection/shortcuts`, token);
    expect(res.status).toBe(200);
    expect(res.jsonResponse).toMatchObject({ skillId, datasetId: null, datasets: 2, episodes: 4, withoutFeatures: 0, evaluationEpisodes: 0 });
    expect(res.jsonResponse.analysis.flags).toHaveProperty("START_CUE");
    let call = critics.analyses.at(-1)!;
    expect(call.path).toBe("/analyses/shortcuts");
    expect(call.body.episodes.map((e) => e.prompt)).toEqual([RED, RED, RED, RED]);

    // one dataset of the selection
    const one = await testFetcher.get(app, `${base}/skills/${skillId}/selection/shortcuts?datasetId=${dsA}`, token);
    expect(one.jsonResponse).toMatchObject({ datasetId: dsA, datasets: 1, episodes: 2 });

    // a report from before the features: counted, left out
    const [row] = await getDb().select({ report: datasets.report }).from(datasets).where(eq(datasets.id, dsA));
    const report = row!.report as DatasetReport;
    for (const ep of report.episodes) for (const c of ep.hard) if (c.id === "diversity") delete (c.metrics as Record<string, unknown>).cue_features;
    await getDb().update(datasets).set({ report }).where(eq(datasets.id, dsA));
    const older = await testFetcher.get(app, `${base}/skills/${skillId}/selection/shortcuts`, token);
    expect(older.jsonResponse).toMatchObject({ episodes: 2, withoutFeatures: 2 });
    await giveFeatures(dsA);

    // the rollouts of an evaluation are compared, never selected
    const policy = await testFetcher.post(app, `${base}/skills/${skillId}/policies`, token, { name: "v1" });
    const evaluation = await testFetcher.post(app, `${base}/blocks`, token, { cellId, skillId, kind: "evaluation", policyId: policy.jsonResponse.id, date: "2026-11-16" });
    const evalBlock = evaluation.jsonResponse.block.id;
    const up = await testFetcher.postFormData(app, `${base}/blocks/${evalBlock}/datasets`, token, zipUpload("rollouts.zip"));
    await testFetcher.get(app, `${base}/blocks/${evalBlock}`, token);
    await giveFeatures(up.jsonResponse.id);
    const withEval = await testFetcher.get(app, `${base}/skills/${skillId}/selection/shortcuts`, token);
    expect(withEval.jsonResponse).toMatchObject({ episodes: 4, evaluationEpisodes: 4 });
    call = critics.analyses.at(-1)!;
    expect(call.body.evaluation).toHaveLength(4);
    expect(withEval.jsonResponse.analysis.evaluation.n).toBe(4);

    expect((await testFetcher.get(app, `${base}/skills/${skillId}/selection/shortcuts?datasetId=${crypto.randomUUID()}`, token)).status).toBe(404);
    expect((await testFetcher.get(app, `${base}/skills/${skillId}/selection/shortcuts`, token2)).status).toBe(403);
  });
});
