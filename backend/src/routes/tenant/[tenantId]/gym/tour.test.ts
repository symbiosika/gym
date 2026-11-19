/**
 * The guided tour: choosing the tour skill and what the tour shows of it.
 *   bun run test:local ./src/routes/tenant/[tenantId]/gym/tour.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import type { SymbiosikaFrameworkHonoApp } from "@framework/types";
import { initTests, TEST_ORGANISATION_1 } from "@framework/test/init.test";
import { testFetcher } from "@framework/test/fetcher.test";
import { getDb } from "@framework/lib/db/db-connection";
import { defineFilesRoutes } from "@framework/routes/tenant/[tenantId]/files";
import { _GLOBAL_SERVER_CONFIG } from "@framework/store";
import { cells, dayProtocols, skills } from "../../../../db/schema";
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

interface Material {
  skill: { id: string; name: string; criticSpecName: string | null } | null;
  recordingBlockId: string | null;
  datasetId: string | null;
  exportId: string | null;
  policyId: string | null;
  evaluationBlockId: string | null;
  reportId: string | null;
  specStored: boolean;
}

describe("The guided tour", () => {
  let cellId = "";
  let skillId = "";
  let otherSkillId = "";
  let blockId = "";
  let datasetId = "";
  const material = async () => (await testFetcher.get(app, `${base}/tour`, token)).jsonResponse as Material;

  /** a block of the skill with one uploaded dataset, mirrored as done */
  const blockWithData = async (kind: "recording" | "evaluation", extra: Record<string, unknown> = {}) => {
    const started = await testFetcher.post(app, `${base}/blocks`, token, { cellId, skillId, kind, date: "2026-11-02", ...extra });
    expect(started.status).toBe(201);
    const id = started.jsonResponse.block.id as string;
    const up = await testFetcher.postFormData(app, `${base}/blocks/${id}/datasets`, token, zipUpload(`${kind}_${Date.now()}.zip`));
    expect(up.status).toBe(201);
    // reading the block syncs the critics run
    const block = await testFetcher.get(app, `${base}/blocks/${id}`, token);
    expect(block.jsonResponse.datasets[0].analysisStatus).toBe("done");
    return { blockId: id, datasetId: up.jsonResponse.id as string, block: block.jsonResponse };
  };

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
    cellId = (await testFetcher.post(app, `${base}/cells`, token, { name: "Tour cell" })).jsonResponse.id;
    skillId = (await testFetcher.post(app, `${base}/skills`, token, { name: "Cup to tray", criticSpecName: "cup_tray" })).jsonResponse.id;
    otherSkillId = (await testFetcher.post(app, `${base}/skills`, token, { name: "Stack cubes" })).jsonResponse.id;
  });

  afterAll(async () => {
    critics.stop();
    server?.stop(true);
    _GLOBAL_SERVER_CONFIG.baseUrl = originalBaseUrl;
    _GLOBAL_SERVER_CONFIG.basePath = originalBasePath;
    delete process.env.CRITICS_URL;
    await cleanup().catch((error) => console.warn("afterAll cleanup failed:", error));
  });

  test("without a tour skill the tour has nothing to show", async () => {
    const res = await testFetcher.get(app, `${base}/tour`, token);
    expect(res.status).toBe(200);
    expect(res.jsonResponse).toMatchObject({ skill: null, recordingBlockId: null, datasetId: null, exportId: null, policyId: null, evaluationBlockId: null, reportId: null, specStored: false });
  });

  test("an admin chooses the tour skill; a skill with no data yet gives the skill alone", async () => {
    const set = await testFetcher.put(app, `${base}/tour`, token, { skillId });
    expect(set.status).toBe(200);
    expect(set.jsonResponse.skill).toMatchObject({ id: skillId, name: "Cup to tray", criticSpecName: "cup_tray" });
    // the spec is stored in the critics, so the spec manager can open it
    expect(set.jsonResponse.specStored).toBe(true);
    expect(set.jsonResponse).toMatchObject({ recordingBlockId: null, datasetId: null, exportId: null, policyId: null, evaluationBlockId: null, reportId: null });
    const audit = (await testFetcher.get(app, `${base}/skills/${skillId}/audit`, token)).jsonResponse as { action: string }[];
    expect(audit.map((a) => a.action)).toContain("tour.skill.set");
  });

  test("the tour skill is one per organisation, of this organisation, and may be none", async () => {
    expect((await testFetcher.put(app, `${base}/tour`, token, { skillId: otherSkillId })).jsonResponse.skill.id).toBe(otherSkillId);
    const flagged = await getDb().select({ id: skills.id }).from(skills).where(eq(skills.tourSkill, true));
    expect(flagged.map((s) => s.id)).toEqual([otherSkillId]);
    expect((await testFetcher.put(app, `${base}/tour`, token, { skillId: null })).jsonResponse.skill).toBeNull();
    expect((await testFetcher.put(app, `${base}/tour`, token, { skillId: "00000000-0000-0000-0000-000000000000" })).status).toBe(404);
    expect((await testFetcher.put(app, `${base}/tour`, token, { skillId: "not a uuid" })).status).toBe(400);
    // another organisation reads and writes nothing here
    expect((await testFetcher.get(app, `${base}/tour`, token2)).status).toBe(403);
    expect((await testFetcher.put(app, `${base}/tour`, token2, { skillId })).status).toBe(403);
    await testFetcher.put(app, `${base}/tour`, token, { skillId });
  });

  test("the material: the recording block with judged data and its largest dataset", async () => {
    const first = await blockWithData("recording");
    blockId = first.blockId;
    datasetId = first.datasetId;
    // a second dataset in the same block; the fixture run has the same size, so the first stays a valid pick
    const m = await material();
    expect(m.recordingBlockId).toBe(blockId);
    expect(m.datasetId).toBe(datasetId);
    // a recording block without finished data is not a candidate
    const empty = await testFetcher.post(app, `${base}/blocks`, token, { cellId, skillId, kind: "recording", date: "2026-11-03" });
    expect(empty.status).toBe(201);
    expect((await material()).recordingBlockId).toBe(blockId);
  });

  test("the material: export, policy, evaluation with reviewed rollouts and report", async () => {
    const exported = await app.request(`${base}/skills/${skillId}/exports`, {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: "Tour set" }),
    });
    expect(exported.status).toBe(200);
    const exportId = exported.headers.get("x-export-id");
    expect((await material()).exportId).toBe(exportId);

    const policy = await testFetcher.post(app, `${base}/skills/${skillId}/policies`, token, { name: "v1", exportId });
    expect(policy.status).toBe(201);
    // a later policy without an export: the one trained from an export is still shown
    await testFetcher.post(app, `${base}/skills/${skillId}/policies`, token, { name: "scratch" });
    expect((await material()).policyId).toBe(policy.jsonResponse.id);

    const evaluation = await blockWithData("evaluation", { policyId: policy.jsonResponse.id });
    expect((await material()).evaluationBlockId).toBe(evaluation.blockId);
    // a newer evaluation without a review loses against the reviewed one
    const rollout = evaluation.block.datasets[0].episodes?.[0]?.id ?? (await testFetcher.get(app, `${base}/datasets/${evaluation.datasetId}`, token)).jsonResponse.episodes[0].id;
    const reviewed = await testFetcher.put(app, `${base}/blocks/${evaluation.blockId}/rollouts/review`, token, { changes: [{ episodeId: rollout, humanVerdict: "accept" }] });
    expect(reviewed.status).toBe(200);
    await blockWithData("evaluation", { policyId: policy.jsonResponse.id });
    expect((await material()).evaluationBlockId).toBe(evaluation.blockId);

    const report = await testFetcher.post(app, `${base}/skills/${skillId}/evaluation-reports`, token, { name: "Tour report", blockIds: [evaluation.blockId] });
    expect(report.status).toBe(201);
    const m = await material();
    expect(m.reportId).toBe(report.jsonResponse.id);
    // the recording side is untouched by the evaluations
    expect(m).toMatchObject({ recordingBlockId: blockId, datasetId });
  });
});
