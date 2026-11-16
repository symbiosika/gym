/**
 * The skill's episodes as datasets: the overview with its figures, a dataset
 * taken in and out of the selection, and the unfiltered export.
 *   bun run test:local ./src/routes/tenant/[tenantId]/gym/selection-overview.test.ts
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
import { cells, datasets, dayProtocols, episodes, skills } from "../../../../db/schema";
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
const post = (path: string, body: unknown = {}, bearer = token) =>
  app.request(path, { method: "POST", headers: { "content-type": "application/json", Authorization: `Bearer ${bearer}` }, body: JSON.stringify(body) });

interface Row {
  dataset: { id: string; name: string; date: string; cellName: string; blockId: string; included: boolean; stored: boolean; analysisStatus: string };
  episodes: number;
  selected: number;
  accepted: number;
  review: number;
  rejected: number;
  reviewPending: number;
  graspSpreadCm: number | null;
  startPoseStdCm: number[] | null;
}
interface Overview {
  skillId: string;
  datasets: Row[];
  totals: { episodes: number; selected: number; accepted: number; review: number; rejected: number };
  metrics: { datasets: number; episodes: number; withoutPositions: number; pick: { all: { n: number } | null; byArm: Record<string, unknown> } };
}

describe("The skill's episodes as datasets", () => {
  let skillId = "";
  let cellId = "";
  let blockId = "";
  let datasetId = "";
  const overview = async () => (await testFetcher.get(app, `${base}/skills/${skillId}/selection/overview`, token)).jsonResponse as Overview;
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
    cellId = (await testFetcher.post(app, `${base}/cells`, token, { name: "Overview cell" })).jsonResponse.id;
    skillId = (await testFetcher.post(app, `${base}/skills`, token, { name: "Cup to tray" })).jsonResponse.id;
    blockId = (await testFetcher.post(app, `${base}/blocks`, token, { cellId, skillId, kind: "recording", date: "2026-10-26" })).jsonResponse.block.id;
    const up = await testFetcher.postFormData(app, `${base}/blocks/${blockId}/datasets`, token, zipUpload("cup_tray_a.zip"));
    expect(up.status).toBe(201);
    datasetId = up.jsonResponse.id;
    // reading the block syncs the critics run: four episodes, two accepted and selected, two rejected
    const block = await testFetcher.get(app, `${base}/blocks/${blockId}`, token);
    expect(block.jsonResponse.datasets[0].analysisStatus).toBe("done");
  });

  afterAll(async () => {
    critics.stop();
    server?.stop(true);
    _GLOBAL_SERVER_CONFIG.baseUrl = originalBaseUrl;
    _GLOBAL_SERVER_CONFIG.basePath = originalBasePath;
    delete process.env.CRITICS_URL;
    await cleanup().catch((error) => console.warn("afterAll cleanup failed:", error));
  });

  test("one row per dataset: where it is from, what is selected of it, and what the critics say about its spread", async () => {
    const res = await testFetcher.get(app, `${base}/skills/${skillId}/selection/overview`, token);
    expect(res.status).toBe(200);
    const o = res.jsonResponse as Overview;
    expect(o.skillId).toBe(skillId);
    expect(o.datasets).toHaveLength(1);
    const row = o.datasets[0]!;
    expect(row.dataset).toMatchObject({ id: datasetId, name: "cup_tray_a", date: "2026-10-26", cellName: "Overview cell", blockId, included: true, stored: true, analysisStatus: "done" });
    expect(row).toMatchObject({ episodes: 4, selected: 2, accepted: 2, review: 0, rejected: 0, reviewPending: 0 });
    // the critics' own figures for the dataset, as they report them
    expect(row.graspSpreadCm).toBeGreaterThanOrEqual(0);
    expect(row.startPoseStdCm).toEqual([0.12, 0.11, 0.04]);
    expect(o.totals).toMatchObject({ episodes: 4, selected: 2 });
    // nothing of the report itself travels with the overview
    expect(row.dataset).not.toHaveProperty("report");
    expect(row.dataset).not.toHaveProperty("analysis");

    expect((await testFetcher.get(app, `${base}/skills/${skillId}/selection/overview`, undefined)).status).toBe(401);
    expect((await testFetcher.get(app, `${base}/skills/${skillId}/selection/overview`, token2)).status).toBe(403);
  });

  test("the position figures are taken over the selected episodes; a report from before the per-arm keys is counted as such", async () => {
    const o = await overview();
    expect(o.metrics.datasets).toBe(1);
    expect(o.metrics.episodes).toBe(2);
    // the fixture is a report of the old shape: its grasps count overall, under no arm
    expect(o.metrics.withoutPositions).toBe(2);
    expect(o.metrics.pick.all!.n).toBe(2);
    expect(o.metrics.pick.byArm).toEqual({});
  });

  test("counts follow the effective verdict, and a review that is open is said so", async () => {
    const eps = await getDb().select().from(episodes).where(eq(episodes.datasetId, datasetId));
    const accepted = eps.find((e) => e.verdict === "accept")!;
    // the critics could not decide on this one (set here, the fixture has no such episode)
    await getDb().update(episodes).set({ verdict: "review" }).where(eq(episodes.id, accepted.id));
    let row = (await overview()).datasets[0]!;
    expect(row).toMatchObject({ selected: 2, accepted: 1, review: 1, rejected: 0, reviewPending: 1 });
    // a person accepts it: the review is done
    const put = await testFetcher.put(app, `${base}/skills/${skillId}/selection`, token, { changes: [{ episodeId: accepted.id, humanVerdict: "accept" }] });
    expect(put.status).toBe(200);
    row = (await overview()).datasets[0]!;
    expect(row).toMatchObject({ selected: 2, accepted: 2, review: 0, reviewPending: 0 });
    await getDb().update(episodes).set({ verdict: "accept", humanVerdict: null }).where(eq(episodes.id, accepted.id));
  });

  test("a dataset is taken out of the selection as a whole: its ticks stay, it counts for nothing, and comes back as it was", async () => {
    const before = await testFetcher.get(app, `${base}/skills/${skillId}/selection`, token);
    const ticks = (before.jsonResponse.datasets[0].episodes as { id: string; selected: boolean }[]).map((e) => [e.id, e.selected]);

    expect((await testFetcher.put(app, `${base}/datasets/${datasetId}/included`, token, {})).status).toBe(400);
    expect((await testFetcher.put(app, `${base}/datasets/${datasetId}/included`, token2, { included: false })).status).toBe(403);
    const out = await testFetcher.put(app, `${base}/datasets/${datasetId}/included`, token, { included: false });
    expect(out.status).toBe(200);
    expect(out.jsonResponse.included).toBe(false);

    // the same "selected" everywhere: the skill's own figure and the key figures follow the overview
    const figures = async () => ({
      skill: (await testFetcher.get(app, `${base}/skills/${skillId}`, token)).jsonResponse.selectedEpisodes as number,
      kpis: (await testFetcher.get(app, `${base}/kpis?skillId=${skillId}`, token)).jsonResponse.totals.selected as number,
    });
    expect(await figures()).toEqual({ skill: 0, kpis: 0 });

    const o = await overview();
    expect(o.datasets[0]!.dataset.included).toBe(false);
    // the row still says what is ticked in it
    expect(o.datasets[0]!.selected).toBe(2);
    expect(o.metrics).toMatchObject({ datasets: 0, episodes: 0, withoutPositions: 0 });
    expect(o.totals.selected).toBe(0);
    const during = await testFetcher.get(app, `${base}/skills/${skillId}/selection`, token);
    expect((during.jsonResponse.datasets[0].episodes as { id: string; selected: boolean }[]).map((e) => [e.id, e.selected])).toEqual(ticks);
    expect(during.jsonResponse.datasets[0].dataset.included).toBe(false);

    // with nothing left in the selection neither export has anything to take
    const light = await post(`${base}/skills/${skillId}/exports`);
    expect(light.status).toBe(400);
    expect(await light.text()).toContain("No episodes selected");
    const merges = critics.merges.length;
    const merged = await post(`${base}/skills/${skillId}/exports/dataset`);
    expect(merged.status).toBe(400);
    expect(await merged.text()).toContain("No episodes selected");
    expect(critics.merges).toHaveLength(merges);
    expect((await testFetcher.get(app, `${base}/skills/${skillId}/exports`, token)).jsonResponse).toHaveLength(0);

    const back = await testFetcher.put(app, `${base}/datasets/${datasetId}/included`, token, { included: true });
    expect(back.jsonResponse.included).toBe(true);
    expect(await figures()).toEqual({ skill: 2, kpis: 2 });
    const again = await overview();
    expect(again.metrics.episodes).toBe(2);
    expect(again.totals.selected).toBe(2);
    expect((await post(`${base}/skills/${skillId}/exports/dataset`)).status).toBe(200);
    expect(critics.merges.at(-1)!.sources[0]!.episodes.sort()).toEqual([0, 1]);
    const seen = await actions();
    expect(seen).toContain("dataset.excluded");
    expect(seen).toContain("dataset.included");
  });

  test("a dataset goes out unfiltered: every episode whatever its verdict or tick, even while it is out of the selection", async () => {
    await testFetcher.put(app, `${base}/datasets/${datasetId}/included`, token, { included: false });
    const exportsBefore = ((await testFetcher.get(app, `${base}/skills/${skillId}/exports`, token)).jsonResponse as unknown[]).length;
    const res = await post(`${base}/datasets/${datasetId}/export-unfiltered`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    expect(res.headers.get("x-export-episodes")).toBe("4");
    expect(res.headers.get("content-disposition")).toContain("cup_tray_a");
    expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(0);
    const call = critics.merges.at(-1)!;
    expect(call.sources).toHaveLength(1);
    expect(call.sources[0]!.dataset).toMatch(/^https?:\/\//);
    expect(call.sources[0]!.episodes).toEqual([0, 1, 2, 3]);
    // the critics really got the stored zip through that link
    expect(critics.fetched.at(-1)).toMatchObject({ status: 200, head: [0x50, 0x4b, 3, 4] });
    // it is a download, not a saved export of the skill
    expect((await testFetcher.get(app, `${base}/skills/${skillId}/exports`, token)).jsonResponse).toHaveLength(exportsBefore);
    const audit = (await testFetcher.get(app, `${base}/skills/${skillId}/audit`, token)).jsonResponse as { action: string; blockId: string | null; dayProtocolId: string | null; details: Record<string, unknown> }[];
    const entry = audit.find((a) => a.action === "export.unfiltered")!;
    expect(entry.blockId).toBe(blockId);
    expect(entry.dayProtocolId).toBeTruthy();
    expect(entry.details).toMatchObject({ datasetId, episodes: 4 });
    expect((await post(`${base}/datasets/${datasetId}/export-unfiltered`, {}, token2)).status).toBe(403);
    await testFetcher.put(app, `${base}/datasets/${datasetId}/included`, token, { included: true });
  });

  test("a dataset recorded before GYM kept the uploads cannot go out: there are no bytes to hand over", async () => {
    const [row] = await getDb().select().from(datasets).where(eq(datasets.id, datasetId));
    await getDb().update(datasets).set({ storageRef: null, storageParts: null }).where(eq(datasets.id, datasetId));
    try {
      expect((await overview()).datasets[0]!.dataset.stored).toBe(false);
      const res = await post(`${base}/datasets/${datasetId}/export-unfiltered`);
      expect(res.status).toBe(400);
      expect(await res.text()).toContain("before GYM kept the uploads");
    } finally {
      await getDb().update(datasets).set({ storageRef: row!.storageRef, storageParts: row!.storageParts }).where(eq(datasets.id, datasetId));
    }
  });

  test("the rollouts of an evaluation are no selection material: nothing to take in or out, and not in the overview", async () => {
    const policy = await testFetcher.post(app, `${base}/skills/${skillId}/policies`, token, { name: "v1" });
    const evaluation = await testFetcher.post(app, `${base}/blocks`, token, { cellId, skillId, kind: "evaluation", policyId: policy.jsonResponse.id, date: "2026-10-26" });
    const up = await testFetcher.postFormData(app, `${base}/blocks/${evaluation.jsonResponse.block.id}/datasets`, token, zipUpload("rollouts.zip"));
    expect(up.status).toBe(201);
    expect((await testFetcher.put(app, `${base}/datasets/${up.jsonResponse.id}/included`, token, { included: false })).status).toBe(400);
    expect((await overview()).datasets.map((d) => d.dataset.id)).toEqual([datasetId]);
    expect(await getDb().select({ id: datasets.id }).from(datasets).where(and(eq(datasets.skillId, skillId), eq(datasets.included, false)))).toHaveLength(0);
  });
});
