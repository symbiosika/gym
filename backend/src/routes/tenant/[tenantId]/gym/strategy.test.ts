/**
 * The strategy of a skill: a description, pictures and PDFs, the run sheet,
 * and a block taking the run sheet over as its recording plan.
 *   bun run test:local ./src/routes/tenant/[tenantId]/gym/strategy.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import type { SymbiosikaFrameworkHonoApp } from "@framework/types";
import { initTests, TEST_ORGANISATION_1 } from "@framework/test/init.test";
import { testFetcher } from "@framework/test/fetcher.test";
import { getDb } from "@framework/lib/db/db-connection";
import { cells, dayProtocols, skills } from "../../../../db/schema";
import { STRATEGY_BUCKET } from "../../../../lib/gym/buckets";
import { readFile } from "../../../../lib/storage";
import defineGymRoutes from "./index";

let app: SymbiosikaFrameworkHonoApp;
let token: string;
/** a user of another organisation */
let token2: string;
const T = TEST_ORGANISATION_1.id;
const base = `/tenant/${T}/gym`;

const cleanup = async () => {
  const db = getDb();
  await db.delete(skills).where(eq(skills.tenantId, T));
  await db.delete(dayProtocols).where(eq(dayProtocols.tenantId, T));
  await db.delete(cells).where(eq(cells.tenantId, T));
};

/** the first rows of a real sheet: one row per episode, a layout every few rows, a quoted cell with a comma */
const SHEET = [
  "episode,layout,background,target_code,target,position,arm,empty_fronts,recorded_prompt,prompt",
  "1,1,1,T,brown tube gel,1F,left,4F,pick the object from the shelf,pick the brown tube gel from the shelf",
  "2,1,1,G,pink shower gel,4B,right,4F,pick the object from the shelf,pick the pink shower gel from the shelf",
  '6,2,1,J,yellow hair care jar,3F,right,"1F,2F",pick the object from the shelf,pick the yellow hair care jar from the shelf',
].join("\n");

const upload = (name: string, type: string, bytes: number[] = [0x89, 0x50, 0x4e, 0x47, 1, 2, 3]) => {
  const form = new FormData();
  form.append("file", new File([new Uint8Array(bytes)], name, { type }));
  return form;
};

describe("Strategy of a skill", () => {
  let skillId = "";
  let cellId = "";

  beforeAll(async () => {
    const tokens = await initTests();
    token = tokens.user1Token;
    token2 = tokens.user2Token;
    app = new Hono();
    defineGymRoutes(app);
    await cleanup();
    cellId = (await testFetcher.post(app, `${base}/cells`, token, { name: "Strategy cell" })).jsonResponse.id;
    skillId = (await testFetcher.post(app, `${base}/skills`, token, { name: "Pick from shelf" })).jsonResponse.id;
    expect(cellId && skillId).toBeTruthy();
  });
  afterAll(async () => {
    await cleanup().catch((error) => console.warn("afterAll cleanup failed:", error));
  });

  const strategy = `${base}/skills`;
  const actions = async () =>
    ((await testFetcher.get(app, `${base}/skills/${skillId}/audit`, token)).jsonResponse as { action: string }[]).map((a) => a.action);

  test("a skill starts without a strategy, and only its organisation reads it", async () => {
    const empty = await testFetcher.get(app, `${strategy}/${skillId}/strategy`, token);
    expect(empty.status).toBe(200);
    expect(empty.jsonResponse).toMatchObject({ text: "", files: [], runSheet: null });
    expect((await testFetcher.get(app, `${strategy}/${skillId}/strategy`, undefined)).status).toBe(401);
    expect((await testFetcher.get(app, `${strategy}/${skillId}/strategy`, token2)).status).toBe(403);
    expect((await testFetcher.get(app, `${strategy}/00000000-0000-0000-0000-000000000000/strategy`, token)).status).toBe(404);
  });

  test("the description is plain text", async () => {
    const saved = await testFetcher.put(app, `${strategy}/${skillId}/strategy`, token, { text: "Five objects, five shelf positions.\nAlternate the arms." });
    expect(saved.status).toBe(200);
    expect(saved.jsonResponse.text).toBe("Five objects, five shelf positions.\nAlternate the arms.");
    expect((await testFetcher.get(app, `${strategy}/${skillId}/strategy`, token)).jsonResponse.text).toContain("Alternate the arms.");
    expect((await testFetcher.put(app, `${strategy}/${skillId}/strategy`, token, { text: "x".repeat(20001) })).status).toBe(400);
    expect(await actions()).toContain("strategy.updated");
  });

  test("pictures and PDFs are kept with the skill and removed again", async () => {
    const files = `${strategy}/${skillId}/strategy/files`;
    const added = await testFetcher.postFormData(app, files, token, upload("layout 1.png", "image/png"));
    expect(added.status).toBe(200);
    expect(added.jsonResponse.files).toHaveLength(1);
    const file = added.jsonResponse.files[0] as { id: string; name: string; mime: string; size: number; ref?: string };
    expect(file).toMatchObject({ name: "layout 1.png", mime: "image/png", size: 7 });
    const pdf = await testFetcher.postFormData(app, files, token, upload("strategy.pdf", "application/pdf", [0x25, 0x50, 0x44, 0x46]));
    expect(pdf.jsonResponse.files.map((f: { name: string }) => f.name)).toEqual(["layout 1.png", "strategy.pdf"]);

    const bytes = await app.request(`${files}/${file.id}`, { headers: { Authorization: `Bearer ${token}` } });
    expect(bytes.status).toBe(200);
    expect(bytes.headers.get("content-type")).toBe("image/png");
    expect([...new Uint8Array(await bytes.arrayBuffer())]).toEqual([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    expect((await app.request(`${files}/${file.id}`, { headers: { Authorization: `Bearer ${token2}` } })).status).toBe(403);

    // only what a strategy is made of
    expect((await testFetcher.postFormData(app, files, token, upload("notes.txt", "text/plain"))).status).toBe(400);
    expect((await testFetcher.postFormData(app, files, token, new FormData())).status).toBe(400);

    const removed = await testFetcher.delete(app, `${files}/${file.id}`, token);
    expect(removed.status).toBe(200);
    expect(removed.jsonResponse.files.map((f: { name: string }) => f.name)).toEqual(["strategy.pdf"]);
    expect((await app.request(`${files}/${file.id}`, { headers: { Authorization: `Bearer ${token}` } })).status).toBe(404);
    expect((await testFetcher.delete(app, `${files}/${file.id}`, token)).status).toBe(404);
    const seen = await actions();
    expect(seen).toContain("strategy.file_added");
    expect(seen).toContain("strategy.file_removed");
  });

  test("the run sheet is read once and stored as rows, grouped by a column of the person's choice", async () => {
    const sheet = `${strategy}/${skillId}/strategy/run-sheet`;
    const imported = await testFetcher.put(app, sheet, token, { fileName: "Pick_from_Shelf_v4.csv", csv: SHEET, groupBy: "layout" });
    expect(imported.status).toBe(200);
    expect(imported.jsonResponse.runSheet).toMatchObject({ fileName: "Pick_from_Shelf_v4.csv", groupBy: "layout" });
    expect(imported.jsonResponse.runSheet.rows).toHaveLength(3);
    expect(imported.jsonResponse.runSheet.rows[2].empty_fronts).toBe("1F,2F");
    // the description and the files are untouched
    expect(imported.jsonResponse.text).toContain("Alternate the arms.");
    expect(imported.jsonResponse.files).toHaveLength(1);

    expect((await testFetcher.put(app, sheet, token, { fileName: "x.csv", csv: SHEET, groupBy: "nope" })).status).toBe(400);
    expect((await testFetcher.put(app, sheet, token, { fileName: "x.csv", csv: "a,b" })).status).toBe(400);
    expect((await testFetcher.put(app, sheet, token, { fileName: "x.csv" })).status).toBe(400);
    // a refused sheet leaves the stored one alone
    expect((await testFetcher.get(app, `${strategy}/${skillId}/strategy`, token)).jsonResponse.runSheet.rows).toHaveLength(3);

    const removed = await testFetcher.delete(app, sheet, token);
    expect(removed.jsonResponse.runSheet).toBeNull();
    const seen = await actions();
    expect(seen).toContain("strategy.run_sheet_imported");
    expect(seen).toContain("strategy.run_sheet_removed");
  });

  test("the skill list and the skill itself do not carry the strategy along", async () => {
    await testFetcher.put(app, `${strategy}/${skillId}/strategy/run-sheet`, token, { fileName: "s.csv", csv: SHEET, groupBy: null });
    const list = (await testFetcher.get(app, `${base}/skills`, token)).jsonResponse as Record<string, unknown>[];
    expect(list.find((s) => s.id === skillId)).not.toHaveProperty("strategy");
    expect((await testFetcher.get(app, `${base}/skills/${skillId}`, token)).jsonResponse).not.toHaveProperty("strategy");
  });

  test("deleting the skill drops the stored files of its strategy", async () => {
    const doomed = (await testFetcher.post(app, `${base}/skills`, token, { name: "Short lived" })).jsonResponse.id as string;
    const added = await testFetcher.postFormData(app, `${strategy}/${doomed}/strategy/files`, token, upload("a.png", "image/png"));
    const ref = (await getDb().select().from(skills).where(eq(skills.id, doomed)))[0]!.strategy!.files[0]!.ref;
    expect(ref).toBeTruthy();
    expect(added.status).toBe(200);
    expect((await testFetcher.delete(app, `${base}/skills/${doomed}`, token)).status).toBeLessThan(300);
    await expect(readFile(T, STRATEGY_BUCKET, ref)).rejects.toThrow();
  });

  describe("a block takes the run sheet over as its recording plan", () => {
    let blockId = "";
    const sheet = () => testFetcher.put(app, `${strategy}/${skillId}/strategy/run-sheet`, token, { fileName: "Pick_from_Shelf_v4.csv", csv: SHEET, groupBy: "layout" });
    type Variation = { label: string; episodes: number; fields?: { name: string; value: string }[] };
    type Step = { id: string; title: string; instructions: string; episodes: number; variations: Variation[] };

    beforeAll(async () => {
      const started = await testFetcher.post(app, `${base}/blocks`, token, { cellId, skillId, kind: "recording", date: "2026-10-26" });
      expect(started.status).toBe(201);
      blockId = started.jsonResponse.block.id;
    });

    test("without a run sheet there is nothing to take over, and the block is as it was", async () => {
      await testFetcher.delete(app, `${strategy}/${skillId}/strategy/run-sheet`, token);
      const refused = await testFetcher.post(app, `${base}/blocks/${blockId}/plan/from-run-sheet`, token, {});
      expect(refused.status).toBe(400);
      expect((await testFetcher.get(app, `${base}/blocks/${blockId}`, token)).jsonResponse.plan).toBeNull();
    });

    test("all rows: a step per group, an episode per row, the wizard on the plan step", async () => {
      await sheet();
      const taken = await testFetcher.post(app, `${base}/blocks/${blockId}/plan/from-run-sheet`, token, {});
      expect(taken.status).toBe(200);
      expect(taken.jsonResponse.step).toBe("plan");
      expect(taken.jsonResponse.progress).toBeNull();
      const plan = taken.jsonResponse.plan as { source: string; summary: string; sceneSetup: string[]; randomizations: string[]; steps: Step[] };
      expect(plan.source).toBe("manual");
      expect(plan.summary).toBe("Run sheet Pick_from_Shelf_v4.csv, rows 1-3");
      expect(plan.sceneSetup).toEqual([]);
      expect(plan.randomizations).toEqual([]);
      expect(plan.steps.map((s) => [s.title, s.episodes])).toEqual([["layout 1", 2], ["layout 2", 1]]);
      expect(plan.steps.every((s) => s.id)).toBe(true);
      expect(plan.steps[0]!.variations[0]!.label).toBe("1 · pick the brown tube gel from the shelf");
      expect(plan.steps[0]!.variations[0]!.fields).toContainEqual({ name: "arm", value: "left" });
      const audit = (await testFetcher.get(app, `${base}/skills/${skillId}/audit`, token)).jsonResponse as { action: string; blockId: string | null; details: Record<string, unknown> }[];
      const entry = audit.find((a) => a.action === "block.plan_from_run_sheet")!;
      expect(entry.blockId).toBe(blockId);
      expect(entry.details).toMatchObject({ rows: "1-3", episodes: 3, steps: 2 });
    });

    test("a range of rows, counted from 1 as the sheet shows them", async () => {
      const two = await testFetcher.post(app, `${base}/blocks/${blockId}/plan/from-run-sheet`, token, { rows: "1-2" });
      expect(two.jsonResponse.plan.steps.map((s: Step) => [s.title, s.episodes])).toEqual([["layout 1", 2]]);
      expect(two.jsonResponse.plan.summary).toBe("Run sheet Pick_from_Shelf_v4.csv, rows 1-2");
      const last = await testFetcher.post(app, `${base}/blocks/${blockId}/plan/from-run-sheet`, token, { rows: "3" });
      expect(last.jsonResponse.plan.steps.map((s: Step) => s.title)).toEqual(["layout 2"]);
      for (const rows of ["9", "0", "2-4", "abc"]) {
        expect((await testFetcher.post(app, `${base}/blocks/${blockId}/plan/from-run-sheet`, token, { rows })).status).toBe(400);
      }
    });

    test("editing the plan afterwards keeps what the sheet said about each episode", async () => {
      const plan = (await testFetcher.post(app, `${base}/blocks/${blockId}/plan/from-run-sheet`, token, {})).jsonResponse.plan as { summary: string; steps: Step[] };
      const before = plan.steps.map((s) => s.variations.map((x) => x.fields));
      // the editor sends the whole plan back, with one instruction written in
      const edited = await testFetcher.put(app, `${base}/blocks/${blockId}/plan`, token, {
        summary: plan.summary,
        steps: plan.steps.map((s, i) => ({ ...s, instructions: i === 0 ? "Front row first" : s.instructions })),
      });
      expect(edited.status).toBe(200);
      const after = edited.jsonResponse.plan.steps as Step[];
      expect(after[0]!.instructions).toBe("Front row first");
      expect(after.map((s) => s.variations.map((x) => x.fields))).toEqual(before);
      // a variation the operator adds by hand has no such values
      const added = await testFetcher.put(app, `${base}/blocks/${blockId}/plan`, token, {
        summary: plan.summary,
        steps: [{ ...after[0]!, variations: [...after[0]!.variations, { label: "one more", episodes: 1 }] }],
      });
      expect(added.jsonResponse.plan.steps[0].variations[2].fields ?? []).toEqual([]);
    });

    test("once recording has started the sheet no longer replaces the plan", async () => {
      const plan = (await testFetcher.post(app, `${base}/blocks/${blockId}/plan/from-run-sheet`, token, {})).jsonResponse.plan as { steps: Step[] };
      expect((await testFetcher.post(app, `${base}/blocks/${blockId}/recording/start`, token, {})).status).toBe(200);
      // the recording window is open
      const open = await testFetcher.post(app, `${base}/blocks/${blockId}/plan/from-run-sheet`, token, {});
      expect(open.status).toBe(409);
      expect((await testFetcher.put(app, `${base}/blocks/${blockId}/recording/progress`, token, { stepId: plan.steps[0]!.id, delta: 1 })).status).toBe(200);
      // and closed again, with an episode recorded
      expect((await testFetcher.put(app, `${base}/blocks/${blockId}/step`, token, { step: "plan" })).status).toBe(200);
      const recorded = await testFetcher.post(app, `${base}/blocks/${blockId}/plan/from-run-sheet`, token, {});
      expect(recorded.status).toBe(409);
      const kept = (await testFetcher.get(app, `${base}/blocks/${blockId}`, token)).jsonResponse;
      expect(kept.plan.steps[0].id).toBe(plan.steps[0]!.id);
      expect(kept.progress.completed[plan.steps[0]!.id]).toBe(1);
    });

    test("an evaluation block has its own plan: the run sheet is for recording", async () => {
      const policy = await testFetcher.post(app, `${base}/skills/${skillId}/policies`, token, { name: "v1" });
      const evaluation = await testFetcher.post(app, `${base}/blocks`, token, { cellId, skillId, kind: "evaluation", policyId: policy.jsonResponse.id, date: "2026-10-26" });
      expect(evaluation.status).toBe(201);
      expect((await testFetcher.post(app, `${base}/blocks/${evaluation.jsonResponse.block.id}/plan/from-run-sheet`, token, {})).status).toBe(400);
    });
  });
});
