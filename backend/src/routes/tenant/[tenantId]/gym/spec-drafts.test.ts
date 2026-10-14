/**
 * The spec wizard: a sample dataset uploaded for the time of the wizard, the
 * critics in auto mode over X of its episodes, the spec drafted step by step,
 * a test run, and the spec stored and named on the skill. Nothing of the
 * sample stays behind.
 *   bun run test:local ./src/routes/tenant/[tenantId]/gym/spec-drafts.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import type { SymbiosikaFrameworkHonoApp } from "@framework/types";
import { initTests, TEST_ORGANISATION_1 } from "@framework/test/init.test";
import { testFetcher } from "@framework/test/fetcher.test";
import { getDb } from "@framework/lib/db/db-connection";
import { defineFilesRoutes } from "@framework/routes/tenant/[tenantId]/files";
import { _GLOBAL_SERVER_CONFIG } from "@framework/store";
import { files } from "@framework/lib/db/schema/files";
import { auditLog, skills, specDrafts } from "../../../../db/schema";
import { UPLOAD_CHUNK_BUCKET } from "../../../../lib/gym/buckets";
import { cleanupStaleSpecDrafts, mergeReports, seedSpec, specFingerprint, withQuestions } from "../../../../lib/gym/spec-drafts";
import { fixtureReport, startFakeCritics, type FakeCritics } from "../../../../lib/critics/fake-server.test-util";
import defineGymRoutes from "./index";

let app: SymbiosikaFrameworkHonoApp;
let token: string;
let critics: FakeCritics;
let server: ReturnType<typeof Bun.serve>;
let originalBaseUrl = "";
let originalBasePath = "";
const T = TEST_ORGANISATION_1.id;
const base = `/tenant/${T}/gym`;
const drafts = `${base}/spec-drafts`;

const CHUNK = 8;
const ZIP = new Uint8Array(Array.from({ length: 20 }, (_, i) => i + 1));
ZIP.set([0x50, 0x4b, 0x03, 0x04], 0);

const cleanup = async () => {
  await getDb().delete(specDrafts).where(eq(specDrafts.tenantId, T));
  await getDb().delete(skills).where(eq(skills.tenantId, T));
};

const storedChunkFiles = () => getDb().select().from(files).where(eq(files.bucket, UPLOAD_CHUNK_BUCKET));

const putChunk = (path: string, body: Uint8Array) =>
  app.request(path, { method: "PUT", headers: { "content-type": "application/octet-stream", Authorization: `Bearer ${token}` }, body });

/** Upload the sample of a draft in chunks and complete it. */
async function uploadSample(draftId: string) {
  const uploads = `${drafts}/${draftId}/uploads`;
  const begun = await testFetcher.post(app, uploads, token, { fileName: "cup_tray_session.zip", bytes: ZIP.byteLength });
  expect(begun.status).toBe(201);
  const id = begun.jsonResponse.uploadId;
  for (let i = 0; i < begun.jsonResponse.chunkCount; i++) {
    expect((await putChunk(`${uploads}/${id}/chunks/${i}`, ZIP.slice(i * CHUNK, (i + 1) * CHUNK))).status).toBe(200);
  }
  return testFetcher.post(app, `${uploads}/${id}/complete`, token, {});
}

describe("Spec wizard", () => {
  let skillId = "";

  beforeAll(async () => {
    const tokens = await initTests();
    token = tokens.user1Token;
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
    process.env.GYM_UPLOAD_CHUNK_SIZE = String(CHUNK);
    await cleanup();
    const skill = await testFetcher.post(app, `${base}/skills`, token, { name: "Cup to tray", taskDescription: "Put the cup on the tray" });
    skillId = skill.jsonResponse.id;
  });

  afterAll(async () => {
    critics.stop();
    server?.stop(true);
    _GLOBAL_SERVER_CONFIG.baseUrl = originalBaseUrl;
    _GLOBAL_SERVER_CONFIG.basePath = originalBasePath;
    delete process.env.CRITICS_URL;
    delete process.env.GYM_UPLOAD_CHUNK_SIZE;
    await cleanup().catch((error) => console.warn("afterAll cleanup failed:", error));
  });

  test("the generated spec is trimmed to what a person decides", () => {
    const seeded = seedSpec(fixtureReport(), "cup_tray");
    expect(seeded.name).toBe("cup_tray");
    expect(seeded.task).toEqual({ instruction: "put the red block in the box", expected_cycles: 1 });
    expect(seeded.robot).toEqual({ type: "test_bot" });
    expect(Array.isArray(seeded.hard_critics)).toBe(true);
    // the indicators are worded afresh from the objects the person names
    expect(seeded.soft_critics).toBeUndefined();
  });

  test("each answer of the model keeps the words it was asked, also once runs are merged", () => {
    const run = (episode: number, words: string) => {
      const r = structuredClone(fixtureReport());
      r.spec = { ...r.spec, soft_critics: { indicators: [{ id: "grasped", description: words }] } };
      const base = r.episodes[0]!;
      const answer = { ...base.soft[0]!, id: "vlm.grasped", score: 1, error: null };
      r.episodes = [{ ...base, episode, soft: [answer, { ...answer, id: "vlm.summary" }] }];
      return withQuestions(r);
    };
    const first = run(0, "Was the cup grasped?");
    expect(first.episodes[0]!.soft[0]!.question).toBe("Was the cup grasped?");
    // the overall word has no criterion behind it
    expect(first.episodes[0]!.soft[1]!.question).toBeUndefined();
    const merged = mergeReports(first, run(1, "Was the cup lifted?"), true);
    expect(merged.episodes.map((e) => e.soft[0]!.question)).toEqual(["Was the cup grasped?", "Was the cup lifted?"]);
  });

  test("from a sample to a stored spec on the skill", async () => {
    const created = await testFetcher.post(app, drafts, token, { skillId, episodes: "0-3" });
    expect(created.status).toBe(201);
    const draft = created.jsonResponse;
    expect(draft.name).toBe("Cup_to_tray");
    expect(draft.skillName).toBe("Cup to tray");
    expect(draft.step).toBe("sample");
    // nothing to work on before the analysis seeded a spec
    expect((await testFetcher.put(app, `${drafts}/${draft.id}`, token, { step: "task" })).status).toBe(409);

    const completed = await uploadSample(draft.id);
    expect(completed.status).toBe(201);
    expect(completed.jsonResponse.step).toBe("analysis");
    // the answer already asked the critics once: the run is going
    expect(completed.jsonResponse.analysisStatus).toBe("running");
    expect(completed.jsonResponse.analysisProgress.hard.total).toBe(4);
    // the critics got the parts, the auto mode, the picked episodes, a sheet of each, and keep no spec
    const job = critics.jobs.at(-1)!;
    expect(job.parts).toHaveLength(3);
    expect(job.spec).toBeNull();
    expect(job.storeAutoSpec).toBe(false);
    expect(job.purpose).toBe("recording");
    expect(job.options).toEqual({ episodes: [0, 1, 2, 3], contact_sheets: true, sheets_for_all: true });

    // the next read has it done and the spec seeded
    const done = await testFetcher.get(app, `${drafts}/${draft.id}`, token);
    expect(done.jsonResponse.analysisStatus).toBe("done");
    expect(done.jsonResponse.analysisCounts).toEqual({ accept: 2, review: 0, reject: 2 });
    expect(done.jsonResponse.spec.task.instruction).toBe("put the red block in the box");
    expect(done.jsonResponse.analysisReport).toBeUndefined();

    const report = await testFetcher.get(app, `${drafts}/${draft.id}/report?run=analysis`, token);
    expect(report.jsonResponse.episodes).toHaveLength(4);
    const sheet = await app.request(`${drafts}/${draft.id}/files/sheets/episode_000000.jpg`, { headers: { Authorization: `Bearer ${token}` } });
    expect(sheet.status).toBe(200);
    expect(sheet.headers.get("content-type")).toBe("image/jpeg");

    // the person works through the steps; every input is saved at once
    const spec = { ...done.jsonResponse.spec, task: { instruction: "put the cup on the tray", objects: [{ name: "cup", role: "target_object" }] } };
    const saved = await testFetcher.put(app, `${drafts}/${draft.id}`, token, { step: "workbench", spec });
    expect(saved.status).toBe(200);
    expect(saved.jsonResponse.step).toBe("workbench");
    expect(saved.jsonResponse.spec.task.instruction).toBe("put the cup on the tray");

    // the test run takes the drafted spec over the same episodes
    const tested = await testFetcher.post(app, `${drafts}/${draft.id}/test`, token, {});
    expect(tested.status).toBe(200);
    const testJob = critics.jobs.at(-1)!;
    expect((testJob.spec as { task: { instruction: string } }).task.instruction).toBe("put the cup on the tray");
    expect(testJob.options).toEqual(job.options);
    expect(tested.jsonResponse.testStatus).toBe("running");
    const testedDone = (await testFetcher.get(app, `${drafts}/${draft.id}`, token)).jsonResponse;
    expect(testedDone.testStatus).toBe("done");
    const hash = testedDone.testRuns[0].specHash;
    expect(hash).toBe(specFingerprint(spec));
    // the frontend takes the same fingerprint (frontend/src/utils/episodes.spec.ts)
    expect(specFingerprint({ task: { instruction: "put the cup on the tray" }, scoring: { accept: 0.7 } })).toBe("7a3c055a");
    expect(testedDone.testSpecs).toEqual({ "0": hash, "1": hash, "2": hash, "3": hash });

    // one episode again with a changed spec: only that one carries the new fingerprint
    const changed = { ...spec, scoring: { accept: 0.5 } };
    const single = await testFetcher.post(app, `${drafts}/${draft.id}/test`, token, { spec: changed, episodes: "2" });
    expect(single.status).toBe(200);
    expect(critics.jobs.at(-1)!.options).toMatchObject({ episodes: [2] });
    const after = (await testFetcher.get(app, `${drafts}/${draft.id}`, token)).jsonResponse;
    expect(after.testSpecs["2"]).toBe(specFingerprint(changed));
    expect(after.testSpecs["0"]).toBe(hash);
    const testReport = (await testFetcher.get(app, `${drafts}/${draft.id}/report?run=test`, token)).jsonResponse;
    expect(testReport.episodes.map((e: { episode: number }) => e.episode)).toEqual([0, 1, 2, 3]);
    // beyond the dataset or not a pick is refused
    expect((await testFetcher.post(app, `${drafts}/${draft.id}/test`, token, { episodes: "199-200" })).status).toBe(400);
    expect((await testFetcher.post(app, `${drafts}/${draft.id}/test`, token, { episodes: "3-1" })).status).toBe(400);

    // a stored spec of the same name is not replaced without asking
    expect((await testFetcher.post(app, `${drafts}/${draft.id}/finish`, token, { name: "cup_tray" })).status).toBe(409);
    const finished = await testFetcher.post(app, `${drafts}/${draft.id}/finish`, token, { name: "cup tray v2" });
    expect(finished.status).toBe(200);
    expect(finished.jsonResponse).toEqual({ name: "cup_tray_v2", skillId, assigned: true });
    expect(critics.specs.find((s) => s.name === "cup_tray_v2")?.spec.task).toEqual(spec.task);
    expect((await testFetcher.get(app, `${base}/skills/${skillId}`, token)).jsonResponse.criticSpecName).toBe("cup_tray_v2");
    const audit = await getDb().select().from(auditLog).where(and(eq(auditLog.tenantId, T), eq(auditLog.action, "spec.created")));
    expect(audit.at(-1)?.skillId).toBe(skillId);

    // the sample is gone: no draft, no chunks, no critics jobs
    expect((await testFetcher.get(app, `${drafts}/${draft.id}`, token)).status).toBe(404);
    expect(await storedChunkFiles()).toHaveLength(0);
    expect(critics.deleted).toEqual(expect.arrayContaining([job.id, testJob.id]));
    expect(critics.deleted).toContain(critics.jobs.at(-1)!.id);
  });

  test("a new pick of episodes runs the analysis again and keeps the spec drafted so far", async () => {
    const draft = (await testFetcher.post(app, drafts, token, { purpose: "evaluation" })).jsonResponse;
    await uploadSample(draft.id);
    expect(critics.jobs.at(-1)!.purpose).toBe("evaluation");
    await testFetcher.get(app, `${drafts}/${draft.id}`, token);
    const spec = { task: { instruction: "my own words" } };
    await testFetcher.put(app, `${drafts}/${draft.id}`, token, { step: "task", spec, episodes: "1, 4-5" });
    const first = critics.jobs.at(-1)!.id;

    const again = await testFetcher.post(app, `${drafts}/${draft.id}/analyze`, token, {});
    expect(again.status).toBe(200);
    expect(again.jsonResponse.step).toBe("task");
    expect(critics.jobs.at(-1)!.options).toMatchObject({ episodes: [1, 4, 5] });
    expect(again.jsonResponse.episodeSelection).toBe("1,4-5");
    expect(critics.deleted).toContain(first);
    const done = await testFetcher.get(app, `${drafts}/${draft.id}`, token);
    expect(done.jsonResponse.analysisStatus).toBe("done");
    expect(done.jsonResponse.spec).toEqual(spec);

    // a pick is written like a print range, and bounded
    expect((await testFetcher.put(app, `${drafts}/${draft.id}`, token, { episodes: "a-b" })).status).toBe(400);
    expect((await testFetcher.put(app, `${drafts}/${draft.id}`, token, { episodes: "0-999" })).status).toBe(400);
  });

  test("the workbench: an episode picked by number, its video, the person's word", async () => {
    const draft = (await testFetcher.post(app, drafts, token, { episodes: "0-3" })).jsonResponse;
    await uploadSample(draft.id);
    await testFetcher.get(app, `${drafts}/${draft.id}`, token);
    const analysisJob = critics.jobs.at(-1)!;

    // an episode the person knows: a small run with the spec the analysis ran with
    const added = await testFetcher.post(app, `${drafts}/${draft.id}/episodes`, token, { episode: 57 });
    expect(added.status).toBe(200);
    expect(added.jsonResponse.extraEpisodes).toEqual([57]);
    const extraJob = critics.jobs.at(-1)!;
    expect(extraJob.options).toEqual({ episodes: [57], contact_sheets: true, sheets_for_all: true });
    expect((extraJob.spec as { task: { instruction: string } }).task.instruction).toBe("put the red block in the box");
    // beyond the dataset is refused, one already there is no new run
    expect((await testFetcher.post(app, `${drafts}/${draft.id}/episodes`, token, { episode: 500 })).status).toBe(400);
    await testFetcher.post(app, `${drafts}/${draft.id}/episodes`, token, { episodes: "1-2" });
    expect(critics.jobs.at(-1)!.id).toBe(extraJob.id);

    // done, it is part of the analysis report
    const done = await testFetcher.get(app, `${drafts}/${draft.id}`, token);
    expect(done.jsonResponse.extraRuns[0].status).toBe("done");
    const report = (await testFetcher.get(app, `${drafts}/${draft.id}/report?run=analysis`, token)).jsonResponse;
    expect(report.episodes.map((e: { episode: number }) => e.episode)).toEqual([0, 1, 2, 3, 57]);
    expect(report.n_episodes).toBe(5);

    // its video comes from its own run, and a player can seek in it
    const auth = { Authorization: `Bearer ${token}` };
    const cams = await testFetcher.get(app, `${drafts}/${draft.id}/episodes/57/videos`, token);
    expect(cams.jsonResponse[0].camera).toBe("observation.images.front");
    const video = await app.request(`${drafts}/${draft.id}/episodes/57/video?camera=observation.images.front`, { headers: { ...auth, Range: "bytes=2-5" } });
    expect(video.status).toBe(206);
    expect(video.headers.get("content-range")).toBe("bytes 2-5/10");
    expect(new Uint8Array(await video.arrayBuffer())).toEqual(new Uint8Array([2, 3, 4, 5]));
    const sheet = await app.request(`${drafts}/${draft.id}/files/sheets/episode_000057.jpg`, { headers: auth });
    expect(sheet.status).toBe(200);

    // the person's word on episodes is kept
    const judged = await testFetcher.put(app, `${drafts}/${draft.id}`, token, { judgments: { "0": "accept", "57": "reject" } });
    expect(judged.jsonResponse.judgments).toEqual({ "0": "accept", "57": "reject" });
    expect((await testFetcher.put(app, `${drafts}/${draft.id}`, token, { judgments: { x: "accept" } })).status).toBe(400);

    // a new analysis takes the picked episode in, and the test run too
    await testFetcher.post(app, `${drafts}/${draft.id}/analyze`, token, {});
    expect(critics.jobs.at(-1)!.options).toMatchObject({ episodes: [0, 1, 2, 3, 57] });
    expect(critics.deleted).toEqual(expect.arrayContaining([analysisJob.id, extraJob.id]));
    expect((await testFetcher.get(app, `${drafts}/${draft.id}`, token)).jsonResponse.extraRuns).toEqual([]);

    expect((await testFetcher.delete(app, `${drafts}/${draft.id}`, token)).status).toBe(204);
  });

  test("discarding a draft removes its sample; an abandoned one goes by itself", async () => {
    const list = await testFetcher.get(app, drafts, token);
    expect(list.jsonResponse.length).toBeGreaterThan(0);
    const [open] = list.jsonResponse;
    expect((await storedChunkFiles()).length).toBeGreaterThan(0);
    expect((await testFetcher.delete(app, `${drafts}/${open.id}`, token)).status).toBe(204);
    expect(await storedChunkFiles()).toHaveLength(0);

    const stale = (await testFetcher.post(app, drafts, token, {})).jsonResponse;
    await uploadSample(stale.id);
    await getDb().update(specDrafts).set({ updatedAt: "2020-01-01 00:00:00" }).where(eq(specDrafts.id, stale.id));
    expect(await cleanupStaleSpecDrafts()).toBe(1);
    expect(await storedChunkFiles()).toHaveLength(0);
    expect((await testFetcher.get(app, `${drafts}/${stale.id}`, token)).status).toBe(404);
  });
});
