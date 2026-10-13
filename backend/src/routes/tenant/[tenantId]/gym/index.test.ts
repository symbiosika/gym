/**
 * The operator's day, end to end, against the embedded test database and a
 * stand-in for the lerobot-critics service (lib/critics/fake-server.test-util.ts):
 * cell → skill → recording block (brief with the phone → plan → recording →
 * upload → critics run → review) → selection → export → policy → evaluation
 * block → next day → print view → close.
 *   bun run test:local ./src/routes/tenant/[tenantId]/gym/index.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { unzipSync, strFromU8 } from "fflate";
import type { SymbiosikaFrameworkHonoApp } from "@framework/types";
import { initTests, TEST_ORG1_USER_2, TEST_ORGANISATION_1, TEST_ORGANISATION_2 } from "@framework/test/init.test";
import { generateUserSessionJwt } from "@framework/lib/auth";
import { testFetcher } from "@framework/test/fetcher.test";
import { getDb } from "@framework/lib/db/db-connection";
import { defineFilesRoutes } from "@framework/routes/tenant/[tenantId]/files";
import { _GLOBAL_SERVER_CONFIG } from "@framework/store";
import { cells, collections, datasets, dayProtocols, skills } from "../../../../db/schema";
import { startFakeCritics, type FakeCritics } from "../../../../lib/critics/fake-server.test-util";
import defineMobileRoutes from "../../../public/mobile";
import defineGymRoutes from "./index";

let app: SymbiosikaFrameworkHonoApp;
let token: string;
let critics: FakeCritics;
/**
 * The app on a real port. The critics are handed a link to a dataset, not the
 * bytes, and a link is only worth something if somebody can actually fetch it,
 * so the stand-in service fetches it over HTTP like the real one does.
 */
let server: ReturnType<typeof Bun.serve>;
let originalBaseUrl = "";
let originalBasePath = "";
/** a plain member of the organisation (no admin role) */
let memberToken: string;
/** a user of another organisation */
let token2: string;
const T = TEST_ORGANISATION_1.id;
const base = `/tenant/${T}/gym`;

const cleanup = async () => {
  const db = getDb();
  await db.delete(skills).where(eq(skills.tenantId, T));
  await db.delete(dayProtocols).where(eq(dayProtocols.tenantId, T));
  await db.delete(cells).where(eq(cells.tenantId, T));
  await db.delete(collections).where(eq(collections.tenantId, T));
};

const json = (path: string, method: string, body?: unknown, bearer?: string) =>
  app.request(path, {
    method,
    headers: { "content-type": "application/json", ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

describe("Gym operator flow", () => {
  let cellId = "";
  let skillId = "";
  /** the second skill, worked in another cell (see "continue on the next day ...") */
  let skill2Id = "";
  let dayId = "";
  let blockId = "";
  let mobileToken = "";
  let shareId = "";

  beforeAll(async () => {
    const tokens = await initTests();
    token = tokens.user1Token;
    token2 = tokens.user2Token;
    memberToken = (await generateUserSessionJwt({ email: TEST_ORG1_USER_2.email, id: TEST_ORG1_USER_2.id, firstname: "", surname: "" }, 86400)).token;
    app = new Hono();
    defineGymRoutes(app);
    defineMobileRoutes(app);
    // the framework's file routes carry the share links GYM hands the critics
    defineFilesRoutes(app, "");
    server = Bun.serve({ port: 0, fetch: (request) => app.fetch(request) });
    originalBaseUrl = _GLOBAL_SERVER_CONFIG.baseUrl;
    originalBasePath = _GLOBAL_SERVER_CONFIG.basePath;
    _GLOBAL_SERVER_CONFIG.baseUrl = `http://127.0.0.1:${server.port}`;
    _GLOBAL_SERVER_CONFIG.basePath = "";
    critics = startFakeCritics();
    process.env.CRITICS_URL = critics.url;
    await cleanup();
  });

  afterAll(async () => {
    critics.stop();
    server?.stop(true);
    _GLOBAL_SERVER_CONFIG.baseUrl = originalBaseUrl;
    _GLOBAL_SERVER_CONFIG.basePath = originalBasePath;
    delete process.env.CRITICS_URL;
    await cleanup().catch((error) => console.warn("afterAll cleanup failed:", error));
  });

  const zipUpload = (fileName: string, name?: string) => {
    const form = new FormData();
    // the fake service does not open the archive; a few bytes stand in for a zipped dataset
    form.append("file", new File([new Blob([new Uint8Array([0x50, 0x4b, 3, 4, 1, 2, 3])])], fileName, { type: "application/zip" }));
    if (name) form.append("name", name);
    return form;
  };

  test("access: unauthenticated 401, other organisation 403", async () => {
    expect((await testFetcher.get(app, `${base}/skills`, undefined)).status).toBe(401);
    expect((await testFetcher.get(app, `/tenant/${TEST_ORGANISATION_2.id}/gym/skills`, token)).status).toBe(403);
    // a member without admin role may read but not create cells
    expect((await testFetcher.post(app, `${base}/cells`, memberToken, { name: "x" })).status).toBe(403);
  });

  test("cells, collections and a skill", async () => {
    const created = await testFetcher.post(app, `${base}/cells`, token, { name: "Cell 13", location: "Riederich", robot: "MAiRA" });
    expect(created.status).toBe(201);
    cellId = created.jsonResponse.id;
    expect((await testFetcher.post(app, `${base}/cells`, token, { name: "Cell 13" })).status).toBe(400);
    const list = await testFetcher.get(app, `${base}/cells`, memberToken);
    expect(list.status).toBe(200);
    expect(list.jsonResponse).toHaveLength(1);
    const col = await testFetcher.post(app, `${base}/collections`, token, { name: "Demo pilot", customer: "Example Robotics" });
    expect(col.status).toBe(201);
    expect((await testFetcher.get(app, `${base}/collections`, token)).jsonResponse[0].skillCount).toBe(0);

    const skill = await testFetcher.post(app, `${base}/skills`, token, {
      name: "Cup to tray",
      collectionId: col.jsonResponse.id,
      taskDescription: "Pick the cup, place it on the tray",
      criticSpecName: "cup_tray",
    });
    expect(skill.status).toBe(201);
    skillId = skill.jsonResponse.id;
    expect(skill.jsonResponse.criticSpecName).toBe("cup_tray");
    expect((await testFetcher.post(app, `${base}/skills`, token, { name: "" })).status).toBe(400);
    expect((await testFetcher.get(app, `${base}/collections`, token)).jsonResponse[0].skillCount).toBe(1);
    const listed = await testFetcher.get(app, `${base}/skills?status=active`, token);
    expect(listed.jsonResponse).toHaveLength(1);
    expect(listed.jsonResponse[0].collectionName).toBe("Demo pilot");
    expect(listed.jsonResponse[0].days).toBe(0);
  });

  test("start a recording block: today's day protocol is created with it, a second block joins the same day", async () => {
    const started = await testFetcher.post(app, `${base}/blocks`, token, { cellId, skillId, date: "2026-09-10" });
    expect(started.status).toBe(201);
    dayId = started.jsonResponse.day.id;
    blockId = started.jsonResponse.block.id;
    expect(started.jsonResponse.block.kind).toBe("recording");
    expect(started.jsonResponse.block.step).toBe("brief");
    expect(started.jsonResponse.block.date).toBe("2026-09-10");
    expect(started.jsonResponse.block.skill.name).toBe("Cup to tray");
    expect(started.jsonResponse.block.cell.name).toBe("Cell 13");
    expect(started.jsonResponse.day.operatorName).toBeTruthy();
    expect(started.jsonResponse.day.blocks).toHaveLength(1);
    shareId = started.jsonResponse.day.shareId;

    // one day protocol per cell and day: another block lands on the same day
    const again = await testFetcher.post(app, `${base}/blocks`, token, { cellId, skillId, date: "2026-09-10" });
    expect(again.status).toBe(201);
    expect(again.jsonResponse.day.id).toBe(dayId);
    expect(again.jsonResponse.day.blocks).toHaveLength(2);
    // the block goes, the day stays
    expect((await testFetcher.delete(app, `${base}/blocks/${again.jsonResponse.block.id}`, token)).status).toBe(204);
    const day = await testFetcher.get(app, `${base}/days/${dayId}`, token);
    expect(day.jsonResponse.blocks).toHaveLength(1);
    expect(day.jsonResponse.cell.name).toBe("Cell 13");
    expect(day.jsonResponse.blocks[0].accessToken).toBeUndefined();
    // an inactive cell, an unknown skill
    expect((await testFetcher.post(app, `${base}/blocks`, token, { cellId, skillId: "00000000-0000-0000-0000-000000000000", date: "2026-09-10" })).status).toBe(404);
  });

  test("brief: target, text from the phone, done signal", async () => {
    const brief = await testFetcher.put(app, `${base}/blocks/${blockId}/brief`, token, { targetEpisodes: 40 });
    expect(brief.status).toBe(200);
    expect(brief.jsonResponse.targetEpisodes).toBe(40);
    const notes = await testFetcher.put(app, `${base}/days/${dayId}`, token, { notes: "Camera 2 recalibrated" });
    expect(notes.jsonResponse.notes).toBe("Camera 2 recalibrated");

    const tok = await testFetcher.get(app, `${base}/blocks/${blockId}/access-token`, token);
    expect(tok.status).toBe(200);
    mobileToken = tok.jsonResponse.token;
    expect(tok.jsonResponse.paths.capture).toContain(mobileToken);
    // the token is stable while valid
    expect((await testFetcher.get(app, `${base}/blocks/${blockId}/access-token`, token)).jsonResponse.token).toBe(mobileToken);

    // the phone: no login, just the token
    const state = await app.request(`/public/gym/m/${mobileToken}`);
    expect(state.status).toBe(200);
    const mobile = (await state.json()) as { cellName: string; skillName: string; kind: string };
    expect(mobile.cellName).toBe("Cell 13");
    expect(mobile.skillName).toBe("Cup to tray");
    expect(mobile.kind).toBe("recording");
    expect((await app.request(`/public/gym/m/${"x".repeat(32)}`)).status).toBe(410);

    const img = new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])], "scene.jpg", { type: "image/jpeg" });
    const form = new FormData();
    form.append("file", img);
    const up = await app.request(`/public/gym/m/${mobileToken}/scene-image`, { method: "POST", body: form });
    expect(up.status).toBe(200);
    expect(((await up.json()) as { hasSceneImage: boolean }).hasSceneImage).toBe(true);
    const badType = new FormData();
    badType.append("file", new File(["x"], "a.txt", { type: "text/plain" }));
    expect((await app.request(`/public/gym/m/${mobileToken}/scene-image`, { method: "POST", body: badType })).status).toBe(400);

    expect((await json(`/public/gym/m/${mobileToken}/scene-text`, "PUT", { text: "Cup on the left, tray on the right, two distractors" })).status).toBe(200);
    const done = await app.request(`/public/gym/m/${mobileToken}/scene-done`, { method: "POST" });
    expect(done.status).toBe(200);

    // the operator view sees it
    const block = await testFetcher.get(app, `${base}/blocks/${blockId}`, token);
    expect(block.jsonResponse.sceneCapturedAt).toBeTruthy();
    expect(block.jsonResponse.sceneText).toContain("distractors");
    expect(block.jsonResponse.hasSceneImage).toBe(true);
    const image = await app.request(`/tenant/${T}/gym/blocks/${blockId}/scene-image`, { headers: { Authorization: `Bearer ${token}` } });
    expect(image.status).toBe(200);
    expect(image.headers.get("content-type")).toBe("image/jpeg");
  });

  test("a recording block runs without a plan: the target on the task, nothing else", async () => {
    const started = await testFetcher.post(app, `${base}/blocks`, token, { cellId, skillId, date: "2026-09-10" });
    const plainId = started.jsonResponse.block.id;
    // without a target there is nothing to count against
    await testFetcher.put(app, `${base}/blocks/${plainId}/brief`, token, { targetEpisodes: null });
    expect((await testFetcher.post(app, `${base}/blocks/${plainId}/recording/start?withoutPlan=true`, token, {})).status).toBe(400);
    await testFetcher.put(app, `${base}/blocks/${plainId}/brief`, token, { targetEpisodes: 12, sceneText: "cup left, tray right" });

    const start = await testFetcher.post(app, `${base}/blocks/${plainId}/recording/start?withoutPlan=true`, token, {});
    expect(start.status).toBe(200);
    expect(start.jsonResponse.step).toBe("recording");
    const plan = start.jsonResponse.plan;
    expect(plan.source).toBe("plain");
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0].episodes).toBe(12);
    expect(plan.steps[0].variations).toHaveLength(1);
    expect(plan.randomizations).toEqual([]);
    // counting works like on any other plan
    const stepId = plan.steps[0].id;
    expect((await testFetcher.put(app, `${base}/blocks/${plainId}/recording/progress`, token, { stepId, delta: 1 })).jsonResponse.progress.completed[stepId]).toBe(1);
    expect((await testFetcher.delete(app, `${base}/blocks/${plainId}`, token)).status).toBe(204);
  });

  test("plan: proposal, edit, recording with progress from the phone", async () => {
    // a recording block without a plan is refused
    expect((await testFetcher.post(app, `${base}/blocks/${blockId}/recording/start`, token, {})).status).toBe(409);

    const gen = await testFetcher.post(app, `${base}/blocks/${blockId}/plan/generate?lang=en`, token, {});
    expect(gen.status).toBe(200);
    expect(gen.jsonResponse.step).toBe("plan");
    const plan = gen.jsonResponse.plan;
    expect(plan.steps.reduce((a: number, s: { episodes: number }) => a + s.episodes, 0)).toBe(40);
    // the kind is fixed once the block has a plan
    expect((await testFetcher.put(app, `${base}/blocks/${blockId}/brief`, token, { kind: "evaluation" })).status).toBe(409);

    const edited = await testFetcher.put(app, `${base}/blocks/${blockId}/plan`, token, {
      summary: "Two setups",
      steps: [
        { id: plan.steps[0].id, title: "Setup A", instructions: "Cup left", variations: [{ label: "near", episodes: 2 }, { label: "far", episodes: 1 }] },
        { title: "Setup B", instructions: "Cup right", variations: [{ label: "rotated", episodes: 3 }] },
      ],
    });
    expect(edited.status).toBe(200);
    expect(edited.jsonResponse.plan.source).toBe("manual");
    expect(edited.jsonResponse.plan.steps).toHaveLength(2);
    const stepA = edited.jsonResponse.plan.steps[0].id;
    const stepB = edited.jsonResponse.plan.steps[1].id;

    const start = await testFetcher.post(app, `${base}/blocks/${blockId}/recording/start`, token, {});
    expect(start.status).toBe(200);
    expect(start.jsonResponse.step).toBe("recording");
    expect(start.jsonResponse.teleopStartedAt).toBeTruthy();
    expect(start.jsonResponse.progress.currentStepId).toBe(stepA);

    // "next" on the phone, three times: step A is complete and the run moves to B
    for (let i = 0; i < 3; i++) expect((await json(`/public/gym/m/${mobileToken}/progress`, "PUT", { stepId: stepA, delta: 1 })).status).toBe(200);
    const state = (await (await app.request(`/public/gym/m/${mobileToken}`)).json()) as { progress: { completed: Record<string, number>; currentStepId: string } };
    expect(state.progress.completed[stepA]).toBe(3);
    expect(state.progress.currentStepId).toBe(stepB);
    // undo never goes below zero
    expect((await json(`/public/gym/m/${mobileToken}/progress`, "PUT", { stepId: stepB, delta: -1 })).status).toBe(200);
    expect((await json(`/public/gym/m/${mobileToken}/progress`, "PUT", { stepId: "nope", delta: 1 })).status).toBe(400);

    // the operator picks the step to work on by hand, here or on the phone; the counts stay as they are
    const picked = await testFetcher.put(app, `${base}/blocks/${blockId}/recording/current-step`, token, { stepId: stepA });
    expect(picked.status).toBe(200);
    expect(picked.jsonResponse.progress.currentStepId).toBe(stepA);
    expect(picked.jsonResponse.progress.completed[stepA]).toBe(3);
    const fromPhone = await json(`/public/gym/m/${mobileToken}/current-step`, "PUT", { stepId: stepB });
    expect(fromPhone.status).toBe(200);
    expect(((await fromPhone.json()) as { progress: { currentStepId: string } }).progress.currentStepId).toBe(stepB);
    expect((await testFetcher.put(app, `${base}/blocks/${blockId}/recording/current-step`, token, { stepId: "nope" })).status).toBe(400);
    expect((await json(`/public/gym/m/${mobileToken}/progress`, "PUT", { stepId: stepB, delta: 1 })).status).toBe(200);
    expect((await json(`/public/gym/m/${mobileToken}/progress`, "PUT", { stepId: stepB, delta: -1 })).status).toBe(200);

    const finish = await testFetcher.post(app, `${base}/blocks/${blockId}/recording/finish`, token, {});
    expect(finish.jsonResponse.step).toBe("upload");
    expect(finish.jsonResponse.teleopEndedAt).toBeTruthy();
    expect(finish.jsonResponse.times.teleopRunning).toBe(false);
    expect(finish.jsonResponse.times.teleopSessions).toBe(1);
  });

  test("teleop time is the sum of the windows, not the span from the first start", async () => {
    const block = await testFetcher.get(app, `${base}/blocks/${blockId}`, token);
    const first = block.jsonResponse.teleopIntervals;
    expect(first).toHaveLength(1);
    expect(first[0].endedAt).toBeTruthy();

    // back into the recording step: a second window opens, entering it again changes nothing
    const again = await testFetcher.post(app, `${base}/blocks/${blockId}/recording/start`, token, {});
    expect(again.jsonResponse.teleopIntervals).toHaveLength(2);
    expect(again.jsonResponse.times.teleopRunning).toBe(true);
    expect((await testFetcher.post(app, `${base}/blocks/${blockId}/recording/start`, token, {})).jsonResponse.teleopIntervals).toHaveLength(2);
    expect(again.jsonResponse.teleopStartedAt).toBe(block.jsonResponse.teleopStartedAt);
    // the day sees a running window
    expect((await testFetcher.get(app, `${base}/days/${dayId}`, token)).jsonResponse.times.teleopRunning).toBe(true);

    const closed = await testFetcher.post(app, `${base}/blocks/${blockId}/recording/finish`, token, {});
    const windows = closed.jsonResponse.teleopIntervals as { startedAt: string; endedAt: string | null }[];
    expect(windows).toHaveLength(2);
    expect(windows.every((w) => w.endedAt)).toBe(true);
    const span = (new Date(closed.jsonResponse.teleopEndedAt).getTime() - new Date(closed.jsonResponse.teleopStartedAt).getTime()) / 60_000;
    const sum = windows.reduce((a, w) => a + (new Date(w.endedAt!).getTime() - new Date(w.startedAt).getTime()) / 60_000, 0);
    expect(sum).toBeLessThanOrEqual(span + 0.001);
    expect(closed.jsonResponse.times.teleopSessions).toBe(2);
    // timestamps leave the API as real instants, not as naive strings
    expect(closed.jsonResponse.teleopStartedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
    expect(closed.jsonResponse.createdAt).toMatch(/Z$/);
  });

  test("stepping away from the recording step stops the clock", async () => {
    const started = await testFetcher.put(app, `${base}/blocks/${blockId}/step`, token, { step: "recording" });
    expect(started.jsonResponse.step).toBe("recording");
    expect(started.jsonResponse.times.teleopRunning).toBe(true);
    const windows = started.jsonResponse.teleopIntervals.length;

    const back = await testFetcher.put(app, `${base}/blocks/${blockId}/step`, token, { step: "plan" });
    expect(back.jsonResponse.step).toBe("plan");
    expect(back.jsonResponse.times.teleopRunning).toBe(false);
    expect(back.jsonResponse.teleopIntervals).toHaveLength(windows);
    expect(back.jsonResponse.teleopIntervals.every((i: { endedAt: string | null }) => i.endedAt)).toBe(true);

    const upload = await testFetcher.put(app, `${base}/blocks/${blockId}/step`, token, { step: "upload" });
    expect(upload.jsonResponse.teleopIntervals).toHaveLength(windows);
    expect(upload.jsonResponse.times.teleopRunning).toBe(false);
  });

  test("downtime belongs to the day and is written down by hand", async () => {
    const added = await testFetcher.post(app, `${base}/days/${dayId}/downtime`, token, { reason: "Gripper jammed", minutes: 25 });
    expect(added.status).toBe(201);
    expect(added.jsonResponse.downtime).toHaveLength(1);
    expect(added.jsonResponse.downtime[0].reason).toBe("Gripper jammed");
    expect(added.jsonResponse.times.downtimeMinutes).toBe(25);

    const second = await testFetcher.post(app, `${base}/days/${dayId}/downtime`, token, { reason: "Network down", minutes: 10 });
    expect(second.jsonResponse.times.downtimeMinutes).toBe(35);
    expect((await testFetcher.post(app, `${base}/days/${dayId}/downtime`, token, { reason: "", minutes: 5 })).status).toBe(400);
    expect((await testFetcher.post(app, `${base}/days/${dayId}/downtime`, token, { reason: "x", minutes: 0 })).status).toBe(400);

    const eventId = added.jsonResponse.downtime[0].id;
    const removed = await testFetcher.delete(app, `${base}/days/${dayId}/downtime/${eventId}`, token);
    expect(removed.status).toBe(200);
    expect(removed.jsonResponse.downtime).toHaveLength(1);
    expect(removed.jsonResponse.times.downtimeMinutes).toBe(10);
    expect((await testFetcher.delete(app, `${base}/days/${dayId}/downtime/${eventId}`, token)).status).toBe(404);
  });

  test("plan images: optional per variation, uploaded, kept while editing, deleted with the variation", async () => {
    const block = await testFetcher.get(app, `${base}/blocks/${blockId}`, token);
    const plan = block.jsonResponse.plan;
    const stepA = plan.steps[0].id;
    const image = (stepId: string, index: number) => `${base}/blocks/${blockId}/plan/steps/${stepId}/variations/${index}/image`;
    const upload = () => {
      const form = new FormData();
      form.append("file", new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 7, 7])], "variation.jpg", { type: "image/jpeg" }));
      return form;
    };

    expect((await testFetcher.post(app, `${image(stepA, 0)}/generate`, token, {})).status).toBe(409);
    expect((await testFetcher.postFormData(app, image(stepA, 9), token, upload())).status).toBe(404);
    expect((await testFetcher.postFormData(app, image("step-nope", 0), token, upload())).status).toBe(404);
    expect((await app.request(image(stepA, 0), { headers: { Authorization: `Bearer ${token}` } })).status).toBe(404);

    const up = await testFetcher.postFormData(app, image(stepA, 0), token, upload());
    expect(up.status).toBe(200);
    const first = up.jsonResponse.plan.steps[0].variations[0].image;
    expect(first.source).toBe("upload");
    expect(up.jsonResponse.plan.steps[0].variations[1].image).toBeNull();

    const scene = await testFetcher.post(app, `${image(stepA, 1)}/from-scene`, token, {});
    expect(scene.status).toBe(200);
    expect(scene.jsonResponse.plan.steps[0].variations[1].image.source).toBe("scene");

    const served = await app.request(image(stepA, 0), { headers: { Authorization: `Bearer ${token}` } });
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("image/jpeg");
    expect((await app.request(`/public/gym/m/${mobileToken}/plan-image/${stepA}/0`)).status).toBe(200);

    // a duplicated step shares the pictures of the original; removing one on the copy leaves the original its file
    const sceneRef = scene.jsonResponse.plan.steps[0].variations[1].image.ref;
    const stepAInput = {
      id: stepA,
      title: "Setup A",
      instructions: "Cup left",
      variations: [
        { label: "near", episodes: 2, image: { ref: first.ref } },
        { label: "far", episodes: 1, image: { ref: sceneRef } },
      ],
    };
    const duplicated = await testFetcher.put(app, `${base}/blocks/${blockId}/plan`, token, {
      summary: "Two setups",
      steps: [stepAInput, { ...stepAInput, id: undefined, title: "Setup A again" }, { id: plan.steps[1].id, title: "Setup B", instructions: "Cup right", variations: [{ label: "rotated", episodes: 3 }] }],
    });
    expect(duplicated.status).toBe(200);
    expect(duplicated.jsonResponse.plan.steps).toHaveLength(3);
    const copyId = duplicated.jsonResponse.plan.steps[1].id;
    expect(copyId).not.toBe(stepA);
    expect(duplicated.jsonResponse.plan.steps[1].variations[0].image.ref).toBe(first.ref);
    const removedOnCopy = await testFetcher.delete(app, image(copyId, 0), token);
    expect(removedOnCopy.status).toBe(200);
    expect(removedOnCopy.jsonResponse.plan.steps[1].variations[0].image).toBeNull();
    expect(removedOnCopy.jsonResponse.plan.steps[0].variations[0].image.ref).toBe(first.ref);
    expect((await app.request(image(stepA, 0), { headers: { Authorization: `Bearer ${token}` } })).status).toBe(200);

    // editing the plan keeps the images that are handed back and drops the others
    const edited = await testFetcher.put(app, `${base}/blocks/${blockId}/plan`, token, {
      summary: "Two setups",
      steps: [
        {
          id: stepA,
          title: "Setup A",
          instructions: "Cup left",
          variations: [
            { label: "near", episodes: 2, imagePrompt: "Move the cup 15 cm to the left.", image: { ref: first.ref } },
            { label: "far", episodes: 1 },
          ],
        },
        { id: plan.steps[1].id, title: "Setup B", instructions: "Cup right", variations: [{ label: "rotated", episodes: 3 }] },
      ],
    });
    expect(edited.status).toBe(200);
    expect(edited.jsonResponse.plan.steps[0].variations[0].image.ref).toBe(first.ref);
    expect(edited.jsonResponse.plan.steps[0].variations[0].imagePrompt).toContain("15 cm");
    expect(edited.jsonResponse.plan.steps[0].variations[1].image).toBeNull();
    expect((await app.request(image(stepA, 1), { headers: { Authorization: `Bearer ${token}` } })).status).toBe(404);
    const invented = await testFetcher.put(app, `${base}/blocks/${blockId}/plan`, token, {
      summary: "Two setups",
      steps: [
        {
          id: stepA,
          title: "Setup A",
          instructions: "Cup left",
          variations: [
            { label: "near", episodes: 2, imagePrompt: "Move the cup 15 cm to the left.", image: { ref: first.ref } },
            { label: "far", episodes: 1, image: { ref: "db:00000000-0000-0000-0000-000000000000" } },
          ],
        },
        { id: plan.steps[1].id, title: "Setup B", instructions: "Cup right", variations: [{ label: "rotated", episodes: 3 }] },
      ],
    });
    expect(invented.jsonResponse.plan.steps[0].variations[1].image).toBeNull();
    const removed = await testFetcher.delete(app, image(plan.steps[1].id, 0), token);
    expect(removed.status).toBe(200);
    expect(removed.jsonResponse.plan.steps[1].variations[0].image).toBeNull();
    // the recording still runs on the same steps
    expect(invented.jsonResponse.progress.completed[stepA]).toBe(3);
  });

  let datasetId = "";
  test("upload: GYM keeps the zip and the critics are handed a link to it, the run is mirrored when it is done", async () => {
    const up = await testFetcher.postFormData(app, `${base}/blocks/${blockId}/datasets`, token, zipUpload("cup_tray_a.zip"));
    expect(up.status).toBe(201);
    datasetId = up.jsonResponse.id;
    expect(up.jsonResponse.name).toBe("cup_tray_a");
    expect(up.jsonResponse.criticsJobId).toBe("job_1");
    expect(up.jsonResponse.skillId).toBe(skillId);
    expect(up.jsonResponse.blockId).toBe(blockId);
    // the first status read of the fake service says "running"
    expect(up.jsonResponse.analysisStatus).toBe("running");
    expect(up.jsonResponse.progress).toEqual({ hard: { done: 2, total: 4 } });
    expect(up.jsonResponse.report).toBeUndefined();
    // the bytes never go to the critics
    expect(critics.uploads).toHaveLength(0);
    expect(critics.jobs[0]!.spec).toBe("cup_tray");
    // the episodes of a recording block are judged as training data
    expect(critics.jobs[0]!.purpose).toBe("recording");
    // what they get is a temporary link, and it really leads to the zip GYM stored
    expect(critics.jobs[0]!.dataset).toMatch(/^https?:\/\//);
    expect(critics.fetched).toHaveLength(1);
    expect(critics.fetched[0]!.status).toBe(200);
    expect(critics.fetched[0]!.head).toEqual([0x50, 0x4b, 3, 4]);
    expect(critics.fetched[0]!.bytes).toBe(7);
    // the name of the dataset at the critics is GYM's own now, not something the service gave back
    expect(up.jsonResponse.criticsDatasetName).toMatch(/^cup_tray_a_20260910_/);

    // reading the block syncs the run: now it is done
    const block = await testFetcher.get(app, `${base}/blocks/${blockId}`, token);
    expect(block.jsonResponse.step).toBe("review");
    expect(block.jsonResponse.datasets).toHaveLength(1);
    expect(block.jsonResponse.datasets[0].analysisStatus).toBe("done");
    expect(block.jsonResponse.datasets[0].analysis.counts).toEqual({ accept: 2, review: 0, reject: 2 });
    expect(block.jsonResponse.datasets[0].analysis.profile.length).toBeGreaterThan(5);
    expect(block.jsonResponse.totals).toEqual({ episodes: 4, accepted: 2, review: 0, rejected: 2, selected: 2, recordedSeconds: 25.5 });
    expect(block.jsonResponse.teleopEndedAt).toBeTruthy();
    expect(block.jsonResponse.times.recordedSeconds).toBe(26);
    expect(block.jsonResponse.times.teleopRunning).toBe(false);
    expect(block.jsonResponse.datasets[0].analysis.softCriticsFailed).toBe(true);
    expect(block.jsonResponse.datasets[0].analysis.softCriticsFailedEpisodes).toBe(4);
    expect(block.jsonResponse.datasets[0].analysis.softCriticsError).toContain("No module named");
    // the day sums its blocks
    const day = await testFetcher.get(app, `${base}/days/${dayId}`, token);
    expect(day.jsonResponse.totals.episodes).toBe(4);
    expect(day.jsonResponse.times.recordedSeconds).toBe(26);
    expect(day.jsonResponse.times.downtimeMinutes).toBe(10);

    const one = await testFetcher.get(app, `${base}/datasets/${datasetId}`, token);
    expect(one.jsonResponse.episodes).toHaveLength(4);
    expect(one.jsonResponse.episodes.filter((e: { selected: boolean }) => e.selected)).toHaveLength(2);
    expect(one.jsonResponse.episodes[2].verdict).toBe("reject");
    expect(one.jsonResponse.episodes[2].reason.blocking).toEqual(["LAGGY"]);
    expect(one.jsonResponse.selection.ranges.accept).toBe("0-1");
    expect(one.jsonResponse.hasReport).toBe(true);
    expect(one.jsonResponse.report).toBeUndefined();

    // the critics' artifacts through GYM
    const report = await testFetcher.get(app, `${base}/datasets/${datasetId}/report`, token);
    expect(report.jsonResponse.n_episodes).toBe(4);
    const html = await app.request(`/tenant/${T}/gym/datasets/${datasetId}/report.html`, { headers: { Authorization: `Bearer ${token}` } });
    expect(html.status).toBe(200);
    const page = await html.text();
    expect(page).toContain("report job_1");
    expect(page).not.toContain("/jobs/job_1/files/");
    expect(page).toContain('href="files/report.md"');
    const linked = await app.request(`/tenant/${T}/gym/datasets/${datasetId}/files/report.md`, { headers: { Authorization: `Bearer ${token}` } });
    expect(linked.status).toBe(200);
    expect(await linked.text()).toContain("lerobot-critics run job_1");
    const md = await app.request(`/tenant/${T}/gym/datasets/${datasetId}/markdown?detail=summary`, { headers: { Authorization: `Bearer ${token}` } });
    expect(await md.text()).toContain("lerobot-critics");

    const notZip = new FormData();
    notZip.append("file", new File(["hello"], "notes.txt", { type: "text/plain" }));
    expect((await testFetcher.postFormData(app, `${base}/blocks/${blockId}/datasets`, token, notZip)).status).toBe(400);

    const follow = await testFetcher.post(app, `${base}/blocks/${blockId}/follow-up?lang=en`, token, {});
    expect(follow.status).toBe(200);
    expect(follow.jsonResponse.followUp.items[0].episodes).toBe(38);

    const status = await testFetcher.get(app, `${base}/critics`, token);
    expect(status.jsonResponse.reachable).toBe(true);
    expect(status.jsonResponse.specs[0].name).toBe("cup_tray");
  });

  test("loop: a second dataset of the same block", async () => {
    expect((await testFetcher.post(app, `${base}/blocks/${blockId}/recording/start`, token, {})).jsonResponse.step).toBe("recording");
    const up = await testFetcher.postFormData(app, `${base}/blocks/${blockId}/datasets`, token, zipUpload("second.zip", "cup_tray_b"));
    expect(up.status).toBe(201);
    expect(up.jsonResponse.name).toBe("cup_tray_b");
    const block = await testFetcher.get(app, `${base}/blocks/${blockId}`, token);
    expect(block.jsonResponse.datasets).toHaveLength(2);
    expect(block.jsonResponse.datasets.every((d: { analysisStatus: string }) => d.analysisStatus === "done")).toBe(true);
    expect(block.jsonResponse.totals.episodes).toBe(8);
  });

  test("while the critics are unreachable an upload is refused", async () => {
    const saved = process.env.CRITICS_URL;
    process.env.CRITICS_URL = "http://127.0.0.1:9";
    try {
      expect((await testFetcher.postFormData(app, `${base}/blocks/${blockId}/datasets`, token, zipUpload("x.zip"))).status).toBe(503);
      const status = (await testFetcher.get(app, `${base}/critics`, token)).jsonResponse;
      expect(status.reachable).toBe(false);
      expect(status.url).toBe("http://127.0.0.1:9");
      // the spec editor still lists every technical check, without parameters
      const checks = (await testFetcher.get(app, `${base}/critics/hard-critics`, token)).jsonResponse;
      expect(checks).toHaveLength(11);
      expect(checks.every((c: { default_params: object }) => Object.keys(c.default_params).length === 0)).toBe(true);
    } finally {
      process.env.CRITICS_URL = saved;
    }
  });

  test("critic specs: a spec file goes into the critics service and is picked per skill", async () => {
    const yaml = ["name: default", "task:", "  instruction: put the cup on the tray", "  scene: a table with a tray", "robot:", "  type: humanoid_v1"].join("\n");
    const form = new FormData();
    form.append("file", new File([yaml], "Cup on Tray.yaml", { type: "application/yaml" }));
    const up = await testFetcher.postFormData(app, `${base}/critics/specs`, token, form);
    expect(up.status).toBe(201);
    expect(up.jsonResponse).toEqual({ name: "Cup_on_Tray", task: "put the cup on the tray", robot: "humanoid_v1" });
    expect(critics.specs[0]!.spec.name).toBe("Cup_on_Tray");

    const named = new FormData();
    named.append("file", new File([JSON.stringify({ task: { instruction: "stack the blocks" } })], "spec.json", { type: "application/json" }));
    named.append("name", "blocks v2");
    expect((await testFetcher.postFormData(app, `${base}/critics/specs`, token, named)).status).toBe(201);
    const bad = new FormData();
    bad.append("file", new File(["robot:\n  type: x\n"], "bad.yaml"));
    expect((await testFetcher.postFormData(app, `${base}/critics/specs`, token, bad)).status).toBe(400);
    expect((await testFetcher.postFormData(app, `${base}/critics/specs`, token, new FormData())).status).toBe(400);

    // the skill switches to the new spec; the block carries the skill's spec for the upload step
    const updated = await testFetcher.put(app, `${base}/skills/${skillId}`, token, { criticSpecName: "Cup_on_Tray" });
    expect(updated.jsonResponse.criticSpecName).toBe("Cup_on_Tray");
    expect((await testFetcher.get(app, `${base}/blocks/${blockId}`, token)).jsonResponse.skill.criticSpecName).toBe("Cup_on_Tray");
  });

  test("critic specs: read, write and remove them from the spec management", async () => {
    // the list says which skills work with which spec
    const list = await testFetcher.get(app, `${base}/critics/specs`, token);
    expect(list.status).toBe(200);
    const mine = list.jsonResponse.find((sp: { name: string }) => sp.name === "Cup_on_Tray");
    expect(mine.task).toBe("put the cup on the tray");
    expect(mine.usedBy).toContain("Cup to tray");

    // one spec comes back as YAML, with the skills that use it
    const one = await testFetcher.get(app, `${base}/critics/specs/Cup_on_Tray`, token);
    expect(one.status).toBe(200);
    expect(one.jsonResponse.yaml).toContain("instruction: put the cup on the tray");
    expect(one.jsonResponse.usedBy).toContain("Cup to tray");
    expect((await testFetcher.get(app, `${base}/critics/specs/does_not_exist`, token)).status).toBe(404);

    // the template is a spec of its own: it parses and can be saved as it is
    const template = await testFetcher.get(app, `${base}/critics/spec-template`, token);
    expect(template.jsonResponse.yaml).toContain("instruction:");
    const written = await testFetcher.put(app, `${base}/critics/specs/edited spec`, token, { text: template.jsonResponse.yaml });
    expect(written.status).toBe(200);
    // the name of the route wins over the name in the text
    expect(written.jsonResponse.name).toBe("edited_spec");
    const edited = critics.specs.find((sp) => sp.name === "edited_spec");
    expect(edited).toBeDefined();
    // the template's indicators sit where the critics read them (soft_critics.indicators), not at the top level
    expect((edited!.spec.soft_critics as { indicators: { id: string }[] }).indicators.map((i) => i.id)).toEqual(["task_completed", "clean_execution"]);
    expect(edited!.spec.soft_indicators).toBeUndefined();

    // the editor renders one row per technical check: the service's list, completed with the ids GYM knows
    const checks = await testFetcher.get(app, `${base}/critics/hard-critics`, token);
    expect(checks.status).toBe(200);
    const ids = checks.jsonResponse.map((c: { id: string }) => c.id);
    expect(ids.slice(0, 2)).toEqual(["duration", "smoothness"]);
    expect(ids).toContain("tracking_error");
    expect(ids).toHaveLength(11);
    expect(checks.jsonResponse[0].default_params.min_s).toBe(5);

    // a spec without a task instruction is refused
    expect((await testFetcher.put(app, `${base}/critics/specs/edited spec`, token, { text: "robot:\n  type: x\n" })).status).toBe(400);
    expect((await testFetcher.put(app, `${base}/critics/specs/edited spec`, token, { text: "  : not: yaml: [" })).status).toBe(400);

    // and it can be removed again
    expect((await testFetcher.delete(app, `${base}/critics/specs/edited_spec`, token)).status).toBe(200);
    expect(critics.specs.some((sp) => sp.name === "edited_spec")).toBe(false);
    expect((await testFetcher.delete(app, `${base}/critics/specs/edited_spec`, token)).status).toBe(404);
  });

  let exportId = "";
  test("selection and export of the skill", async () => {
    const sel = await testFetcher.get(app, `${base}/skills/${skillId}/selection`, token);
    expect(sel.status).toBe(200);
    expect(sel.jsonResponse.datasets).toHaveLength(2);
    expect(sel.jsonResponse.totals).toEqual({ episodes: 8, accepted: 4, review: 0, rejected: 4, selected: 4 });
    expect(sel.jsonResponse.datasets[0].dataset.criticsDatasetName).toMatch(/^cup_tray_a_20260910_/);
    const first = sel.jsonResponse.datasets[0].episodes;
    const rejected = first.find((e: { verdict: string }) => e.verdict === "reject");
    const accepted = first.find((e: { verdict: string }) => e.verdict === "accept");
    const put = await testFetcher.put(app, `${base}/skills/${skillId}/selection`, token, {
      changes: [{ episodeId: rejected.id, selected: true }, { episodeId: accepted.id, selected: false }],
    });
    expect(put.status).toBe(200);
    expect(put.jsonResponse.totals.selected).toBe(4);

    const res = await app.request(`/tenant/${T}/gym/skills/${skillId}/exports`, {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: "First export" }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    exportId = res.headers.get("x-export-id")!;
    const zip = unzipSync(new Uint8Array(await res.arrayBuffer()));
    const manifest = JSON.parse(strFromU8(zip["manifest.json"]!));
    expect(manifest.skill).toBe("Cup to tray");
    expect(manifest.episodes).toBe(4);
    expect(manifest.datasets).toHaveLength(2);
    expect(manifest.datasets[0].criticsJob).toBe("job_1");
    expect(manifest.datasets[0].episodes.sort()).toEqual([1, 2]);
    expect(manifest.datasets[0].ranges).toBe("1-2");
    expect(manifest.datasets[1].ranges).toBe("0-1");
    expect(Object.keys(zip).some((k) => k.endsWith("/selection.json"))).toBe(true);

    const list = await testFetcher.get(app, `${base}/skills/${skillId}/exports`, token);
    expect(list.jsonResponse).toHaveLength(1);
    expect((await app.request(`/tenant/${T}/gym/exports/${exportId}/download`, { headers: { Authorization: `Bearer ${token}` } })).status).toBe(200);
  });

  test("selection: the operator overrules the critics on an episode, the critics' verdict stays", async () => {
    const sel = await testFetcher.get(app, `${base}/skills/${skillId}/selection`, token);
    expect(sel.jsonResponse.datasets[0].dataset.date).toBe("2026-09-10");
    expect(sel.jsonResponse.datasets[0].dataset.cellName).toBeTruthy();
    const target = sel.jsonResponse.datasets[0].episodes.find((e: { verdict: string; selected: boolean }) => e.verdict === "reject" && !e.selected);
    expect(target).toBeTruthy();

    // accept: the episode counts as accepted and goes into the selection
    const put = await testFetcher.put(app, `${base}/skills/${skillId}/selection`, token, { changes: [{ episodeId: target.id, humanVerdict: "accept" }] });
    expect(put.status).toBe(200);
    const after = put.jsonResponse.datasets[0].episodes.find((e: { id: string }) => e.id === target.id);
    expect(after).toMatchObject({ verdict: "reject", humanVerdict: "accept", selected: true });
    expect(after.reviewedByName).toBeTruthy();
    expect(put.jsonResponse.totals).toEqual({ ...sel.jsonResponse.totals, accepted: sel.jsonResponse.totals.accepted + 1, rejected: sel.jsonResponse.totals.rejected - 1, selected: sel.jsonResponse.totals.selected + 1 });
    // the block's figures and the skill's follow the effective verdict
    const blockAfter = await testFetcher.get(app, `${base}/blocks/${blockId}`, token);
    expect(blockAfter.jsonResponse.totals.accepted).toBe(sel.jsonResponse.totals.accepted + 1);
    const audit = await testFetcher.get(app, `${base}/skills/${skillId}/audit`, token);
    expect(audit.jsonResponse.find((a: { action: string }) => a.action === "selection.verdicts").details).toMatchObject({ accepted: 1, rejected: 0, reset: 0, selected: 1 });
    // an unknown verdict is refused
    expect((await testFetcher.put(app, `${base}/skills/${skillId}/selection`, token, { changes: [{ episodeId: target.id, humanVerdict: "review" }] })).status).toBe(400);

    // back to the critics, and out of the selection again in the same change
    const reset = await testFetcher.put(app, `${base}/skills/${skillId}/selection`, token, { changes: [{ episodeId: target.id, humanVerdict: null, selected: false }] });
    expect(reset.jsonResponse.datasets[0].episodes.find((e: { id: string }) => e.id === target.id)).toMatchObject({ verdict: "reject", humanVerdict: null, selected: false, reviewedByName: "" });
    expect(reset.jsonResponse.totals).toEqual(sel.jsonResponse.totals);
  });

  test("the same selection as one merged dataset, ready for training", async () => {
    const res = await app.request(`/tenant/${T}/gym/skills/${skillId}/exports/dataset`, {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: "Training set" }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    expect(res.headers.get("x-export-episodes")).toBe("4");
    expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(0);
    const call = critics.merges.at(-1)!;
    expect(call.sources).toHaveLength(2);
    // a fresh link per dataset, and the name travels beside it because a link
    // carries a token and not a name
    expect(call.sources[0]!.dataset).toMatch(/^https?:\/\//);
    expect(call.sources[0]!.name).toMatch(/^cup_tray_a_20260910_/);
    expect(call.sources[0]!.episodes.sort()).toEqual([1, 2]);
    // and the critics really got the stored zips through those links
    const merged = critics.fetched.slice(-2);
    expect(merged.map((f) => f.status)).toEqual([200, 200]);
    expect(merged.every((f) => f.head[0] === 0x50 && f.head[1] === 0x4b)).toBe(true);
    expect((await testFetcher.get(app, `${base}/skills/${skillId}/exports`, token)).jsonResponse).toHaveLength(2);

    critics.failMergeWith = { status: 400, detail: "different fps: 'a' is 10.0, 'b' is 30.0" };
    try {
      const refused = await app.request(`/tenant/${T}/gym/skills/${skillId}/exports/dataset`, {
        method: "POST",
        headers: { "content-type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({}),
      });
      expect(refused.status).toBe(400);
      expect(await refused.text()).toContain("different fps");
    } finally {
      critics.failMergeWith = null;
    }
  });

  let evalBlockId = "";

  let reportId = "";
  test("evaluation: a policy of the skill is tested in a block of the same day, its rollouts never reach the export", async () => {
    // the policy trained from the export
    const policy = await testFetcher.post(app, `${base}/skills/${skillId}/policies`, token, { name: "v1", exportId, trainedAt: "2026-09-10T18:00:00Z" });
    expect(policy.status).toBe(201);
    expect(policy.jsonResponse.exportId).toBe(exportId);
    expect((await testFetcher.post(app, `${base}/skills/${skillId}/policies`, token, { name: "x", exportId: "00000000-0000-0000-0000-000000000000" })).status).toBe(400);
    const policyId = policy.jsonResponse.id as string;
    // a policy is only for evaluations
    expect((await testFetcher.post(app, `${base}/blocks`, token, { cellId, skillId, kind: "recording", policyId, date: "2026-09-10" })).status).toBe(400);

    const started = await testFetcher.post(app, `${base}/blocks`, token, { cellId, skillId, kind: "evaluation", policyId, date: "2026-09-10" });
    expect(started.status).toBe(201);
    evalBlockId = started.jsonResponse.block.id;
    expect(started.jsonResponse.day.id).toBe(dayId);
    expect(started.jsonResponse.block.kind).toBe("evaluation");
    expect(started.jsonResponse.block.policy.name).toBe("v1");
    // nothing is carried over from the recording blocks: an evaluation starts from its own kind
    expect(started.jsonResponse.block.plan).toBeNull();

    // the kind still changes while the block is empty, and back
    expect((await testFetcher.put(app, `${base}/blocks/${evalBlockId}/brief`, token, { kind: "recording" })).jsonResponse.policy).toBeNull();
    const back = await testFetcher.put(app, `${base}/blocks/${evalBlockId}/brief`, token, { kind: "evaluation", policyId, targetEpisodes: 6 });
    expect(back.jsonResponse.kind).toBe("evaluation");
    expect(back.jsonResponse.policy.id).toBe(policyId);

    // an evaluation runs without a plan: one step, the rollouts of the target
    const start = await testFetcher.post(app, `${base}/blocks/${evalBlockId}/recording/start`, token, {});
    expect(start.status).toBe(200);
    expect(start.jsonResponse.step).toBe("recording");
    expect(start.jsonResponse.plan.steps).toHaveLength(1);
    expect(start.jsonResponse.plan.steps[0].episodes).toBe(6);
    // it covers the settings the skill was recorded with
    expect(start.jsonResponse.plan.steps[0].variations.map((x: { label: string }) => x.label)).toEqual(["near", "far", "rotated"]);
    const stepId = start.jsonResponse.plan.steps[0].id;
    expect((await testFetcher.put(app, `${base}/blocks/${evalBlockId}/recording/progress`, token, { stepId, delta: 1 })).jsonResponse.progress.completed[stepId]).toBe(1);
    expect((await testFetcher.post(app, `${base}/blocks/${evalBlockId}/recording/finish`, token, {})).jsonResponse.step).toBe("upload");

    // the AI plan for an evaluation, without a model: the recorded settings again
    const gen = await testFetcher.post(app, `${base}/blocks/${evalBlockId}/plan/generate?lang=en`, token, {});
    expect(gen.jsonResponse.plan.source).toBe("fallback");
    expect(gen.jsonResponse.plan.summary).toContain("rollouts");

    // the rollouts go to the critics like any dataset
    const up = await testFetcher.postFormData(app, `${base}/blocks/${evalBlockId}/datasets`, token, zipUpload("rollouts_v1.zip"));
    expect(up.status).toBe(201);
    // with the skill's spec, but judged as rollouts of a policy
    expect(critics.jobs.at(-1)).toMatchObject({ spec: "Cup_on_Tray", purpose: "evaluation" });
    const block = await testFetcher.get(app, `${base}/blocks/${evalBlockId}`, token);
    expect(block.jsonResponse.step).toBe("review");
    expect(block.jsonResponse.totals.episodes).toBe(4);
    expect(block.jsonResponse.totals.accepted).toBe(2);
    // no selection step for an evaluation
    expect((await testFetcher.put(app, `${base}/blocks/${evalBlockId}/step`, token, { step: "selection" })).status).toBe(409);

    // the skill's selection and export do not see the rollouts
    const sel = await testFetcher.get(app, `${base}/skills/${skillId}/selection`, token);
    expect(sel.jsonResponse.datasets).toHaveLength(2);
    expect(sel.jsonResponse.totals.episodes).toBe(8);
    const rollout = (await testFetcher.get(app, `${base}/datasets/${up.jsonResponse.id}`, token)).jsonResponse.episodes[0];
    const put = await testFetcher.put(app, `${base}/skills/${skillId}/selection`, token, { changes: [{ episodeId: rollout.id, selected: false }] });
    expect(put.jsonResponse.totals.selected).toBe(4);
    expect((await testFetcher.get(app, `${base}/datasets/${up.jsonResponse.id}`, token)).jsonResponse.episodes[0].selected).toBe(true);

    // but the skill knows how its policy did
    const skill = await testFetcher.get(app, `${base}/skills/${skillId}`, token);
    expect(skill.jsonResponse.recordingBlocks).toBe(1);
    expect(skill.jsonResponse.evaluationBlocks).toBe(1);
    expect(skill.jsonResponse.datasets).toBe(2);
    expect(skill.jsonResponse.episodes).toBe(8);
    expect(skill.jsonResponse.policies).toBe(1);
    expect(skill.jsonResponse.policies_[0].name).toBe("v1");
    expect(skill.jsonResponse.evaluations).toHaveLength(1);
    expect(skill.jsonResponse.evaluations[0]).toMatchObject({ blockId: evalBlockId, date: "2026-09-10", cellName: "Cell 13", policyName: "v1", episodes: 4, accepted: 2, successRatePercent: 50 });
    expect(skill.jsonResponse.lastEvaluation.successRatePercent).toBe(50);
    expect(skill.jsonResponse.blocks_).toHaveLength(2);

    // the day keeps the two apart
    const day = await testFetcher.get(app, `${base}/days/${dayId}`, token);
    expect(day.jsonResponse.blocks).toHaveLength(2);
    expect(day.jsonResponse.totals.episodes).toBe(8);
    expect(day.jsonResponse.evaluation).toEqual({ blocks: 1, episodes: 4, accepted: 2 });
    expect(typeof day.jsonResponse.times.evaluationMinutes).toBe("number");
  });

  test("human review: a person overrules the critics on a rollout, the success rate follows, and a report reads it", async () => {
    // the rollouts of the evaluation block as the reviewer sees them
    const list = await testFetcher.get(app, `${base}/blocks/${evalBlockId}/rollouts`, token);
    expect(list.status).toBe(200);
    expect(list.jsonResponse.rollouts).toHaveLength(4);
    expect(list.jsonResponse.totals).toMatchObject({ rollouts: 4, succeeded: 2, ratePercent: 50, reviewed: 0, invalid: 0 });
    expect(list.jsonResponse.failureCodes.map((f: { code: string }) => f.code)).toContain("F-01");
    // the rollouts follow the plan in order: 6 planned on three variations, 2 each
    expect(list.jsonResponse.variations.map((x: { label: string }) => x.label)).toEqual(["near", "far", "rotated"]);
    expect(list.jsonResponse.rollouts.map((r: { variation: string | null }) => r.variation)).toEqual(["near", "near", "far", "far"]);
    // what the model said per rollout comes from the mirrored report; in the fixture it never answered
    expect(list.jsonResponse.rollouts[0].vlm).toMatchObject({ taskSuccess: null, error: "ModuleNotFoundError: No module named 'google'" });
    const rollouts = list.jsonResponse.rollouts as { episodeId: string; criticsVerdict: string; verdict: string; suggestedFailureCode: string | null }[];
    const rejected = rollouts.filter((r) => r.criticsVerdict === "reject");
    const accepted = rollouts.filter((r) => r.criticsVerdict === "accept");
    // the critics' findings suggest a failure code to the reviewer; a success gets none
    expect(accepted.every((r) => r.suggestedFailureCode === null)).toBe(true);
    expect(rejected.every((r) => typeof r.suggestedFailureCode === "string")).toBe(true);
    // a recording block has no rollouts to review
    expect((await testFetcher.get(app, `${base}/blocks/${blockId}/rollouts`, token)).status).toBe(409);

    // the person says: this one succeeded after all, that one did not (grasp failure), and this one ran in another setting
    const reviewed = await testFetcher.put(app, `${base}/blocks/${evalBlockId}/rollouts/review`, token, {
      changes: [
        { episodeId: rejected[0]!.episodeId, humanVerdict: "accept", note: "cup was in the zone, the camera missed it" },
        { episodeId: accepted[0]!.episodeId, humanVerdict: "reject", failureCode: "F-01" },
        { episodeId: rejected[1]!.episodeId, failureCode: "F-08", variationLabel: "rotated" },
      ],
    });
    expect(reviewed.status).toBe(200);
    const byId = new Map((reviewed.jsonResponse.rollouts as { episodeId: string; verdict: string; humanVerdict: string | null; failureCode: string | null; note: string; variation: string; variationSet: boolean; invalid: boolean; reviewedByName: string }[]).map((r) => [r.episodeId, r]));
    expect(byId.get(rejected[0]!.episodeId)).toMatchObject({ verdict: "accept", humanVerdict: "accept", note: "cup was in the zone, the camera missed it" });
    expect(byId.get(rejected[0]!.episodeId)!.reviewedByName).toBeTruthy();
    expect(byId.get(accepted[0]!.episodeId)).toMatchObject({ verdict: "reject", humanVerdict: "reject", failureCode: "F-01" });
    expect(byId.get(rejected[1]!.episodeId)).toMatchObject({ verdict: "reject", humanVerdict: null, failureCode: "F-08", variation: "rotated", variationSet: true, invalid: true });
    // still 2 of 4, but one of the failures is not the policy's: 2 of 3 are charged
    expect(reviewed.jsonResponse.totals).toMatchObject({ rollouts: 4, succeeded: 2, ratePercent: 50, reviewed: 2, invalid: 1, attributableRatePercent: 66.7 });
    expect(reviewed.jsonResponse.totals.failures).toEqual({ "F-01": 1, "F-08": 1 });
    // an episode of another block is refused, a bad code too
    const foreign = (await testFetcher.get(app, `${base}/datasets/${datasetId}`, token)).jsonResponse.episodes[0].id;
    expect((await testFetcher.put(app, `${base}/blocks/${evalBlockId}/rollouts/review`, token, { changes: [{ episodeId: foreign, humanVerdict: "accept" }] })).status).toBe(400);
    expect((await testFetcher.put(app, `${base}/blocks/${evalBlockId}/rollouts/review`, token, { changes: [{ episodeId: rejected[0]!.episodeId, failureCode: "F-99" }] })).status).toBe(400);

    // the human verdict is the block's, the skill's and the key figures' word
    const back = await testFetcher.put(app, `${base}/blocks/${evalBlockId}/rollouts/review`, token, { changes: [{ episodeId: accepted[0]!.episodeId, humanVerdict: null, failureCode: null }] });
    expect(back.jsonResponse.totals).toMatchObject({ succeeded: 3, ratePercent: 75 });
    expect((await testFetcher.get(app, `${base}/blocks/${evalBlockId}`, token)).jsonResponse.totals.accepted).toBe(3);
    expect((await testFetcher.get(app, `${base}/skills/${skillId}`, token)).jsonResponse.evaluations[0].successRatePercent).toBe(75);
    expect((await testFetcher.get(app, `${base}/kpis?from=2026-09-10&to=2026-09-10`, token)).jsonResponse.totals.evaluation).toMatchObject({ episodes: 4, accepted: 3, successRatePercent: 75 });
    // the export of the recording episodes is untouched by it
    expect((await testFetcher.get(app, `${base}/skills/${skillId}/selection`, token)).jsonResponse.totals.accepted).toBe(4);

    // the report over the evaluation blocks of the skill
    expect((await testFetcher.post(app, `${base}/skills/${skillId}/evaluation-reports`, token, { name: "CW38", blockIds: [blockId] })).status).toBe(400);
    expect((await testFetcher.post(app, `${base}/skills/${skillId}/evaluation-reports`, token, { name: "CW38", blockIds: [] })).status).toBe(400);
    const created = await testFetcher.post(app, `${base}/skills/${skillId}/evaluation-reports`, token, {
      name: "CW38 cup to tray",
      blockIds: [evalBlockId],
      sections: { prompt: "Pick the cup and place it on the tray", successCriteria: "Cup released and stationary on the tray" },
    });
    expect(created.status).toBe(201);
    reportId = created.jsonResponse.id;
    expect(created.jsonResponse.shareId).toBeTruthy();
    expect(created.jsonResponse.skill.name).toBe("Cup to tray");
    expect(created.jsonResponse.sections.prompt).toBe("Pick the cup and place it on the tray");
    expect(created.jsonResponse.sections.nextSteps).toBe("");
    const figures = created.jsonResponse.figures;
    expect(figures.overall).toMatchObject({ rollouts: 4, succeeded: 3, ratePercent: 75, invalid: 1, attributableRatePercent: 100 });
    expect(figures.blocks).toHaveLength(1);
    expect(figures.blocks[0]).toMatchObject({ blockId: evalBlockId, label: "v1", policyName: "v1", cellName: "Cell 13", date: "2026-09-10", succeeded: 3, rollouts: 4 });
    expect(figures.blocks[0].ci.low).toBeLessThan(75);
    expect(figures.blocks[0].ci.high).toBeGreaterThan(75);
    expect(figures.variations.map((x: { label: string; rollouts: number }) => [x.label, x.rollouts])).toEqual([["near", 2], ["far", 1], ["rotated", 1]]);
    expect(figures.failureModes).toEqual([{ code: "F-08", name: "Hardware / infrastructure (not charged to the policy)", count: 1, perBlock: { [evalBlockId]: 1 } }]);
    expect(figures.best).toEqual({ blockId: evalBlockId, label: "v1", ratePercent: 75 });
    expect(figures.rollouts).toHaveLength(4);

    // the written parts are updated on their own; the figures stay live
    const updated = await testFetcher.put(app, `${base}/evaluation-reports/${reportId}`, token, { sections: { nextSteps: "Attack F-01 first" }, name: "CW38 cup to tray v1.0" });
    expect(updated.jsonResponse.name).toBe("CW38 cup to tray v1.0");
    expect(updated.jsonResponse.sections).toMatchObject({ prompt: "Pick the cup and place it on the tray", nextSteps: "Attack F-01 first" });
    expect((await testFetcher.get(app, `${base}/skills/${skillId}/evaluation-reports`, token)).jsonResponse).toHaveLength(1);
    // another organisation sees nothing: the report is not found under its tenant
    expect((await testFetcher.get(app, `/tenant/${TEST_ORGANISATION_2.id}/gym/evaluation-reports/${reportId}`, token2)).status).toBe(404);

    // the shared, read-only view
    const shared = await app.request(`/public/gym/eval-report/${created.jsonResponse.shareId}`);
    expect(shared.status).toBe(200);
    const pub = (await shared.json()) as { name: string; skill: { name: string }; figures: { overall: { succeeded: number } }; sections: { nextSteps: string } };
    expect(pub.name).toBe("CW38 cup to tray v1.0");
    expect(pub.skill.name).toBe("Cup to tray");
    expect(pub.figures.overall.succeeded).toBe(3);
    expect(pub.sections.nextSteps).toBe("Attack F-01 first");
    expect((await app.request(`/public/gym/eval-report/nope-nope-nope`)).status).toBe(404);
  });

  test("a summary stored before the shape changed is rebuilt from the report when the dataset is read", async () => {
    const block = await testFetcher.get(app, `${base}/blocks/${blockId}`, token);
    const second = (block.jsonResponse.datasets as { id: string; name: string; analysis: Record<string, unknown> }[]).find((d) => d.name === "cup_tray_b")!;
    expect(second.analysis.version).toBe(2);
    // an old summary: no version, none of the newer fields (critics, overrides, rawFlagCounts)
    const { version: _v, critics: _c, overrides: _o, rawFlagCounts: _r, ...old } = second.analysis;
    await getDb().update(datasets).set({ analysis: old as never }).where(eq(datasets.id, second.id));
    const stale = (await getDb().select({ analysis: datasets.analysis }).from(datasets).where(eq(datasets.id, second.id)))[0]!.analysis as unknown as Record<string, unknown>;
    expect(stale.critics).toBeUndefined();
    // read through the block, the dataset and the selection: every path rebuilds it
    const viaBlock = (await testFetcher.get(app, `${base}/blocks/${blockId}`, token)).jsonResponse.datasets.find((d: { id: string }) => d.id === second.id).analysis;
    expect(viaBlock.version).toBe(2);
    expect(viaBlock.critics.map((c: { id: string }) => c.id)).toContain("duplication");
    expect(viaBlock.overrides).toEqual({ ignoreFlags: [], reviewFlags: [], disabledCritics: [] });
    await getDb().update(datasets).set({ analysis: old as never }).where(eq(datasets.id, second.id));
    expect((await testFetcher.get(app, `${base}/datasets/${second.id}`, token)).jsonResponse.analysis.critics.length).toBeGreaterThan(0);
    await getDb().update(datasets).set({ analysis: old as never }).where(eq(datasets.id, second.id));
    const viaSelection = (await testFetcher.get(app, `${base}/skills/${skillId}/selection`, token)).jsonResponse.datasets.find((d: { dataset: { id: string } }) => d.dataset.id === second.id).dataset.analysis;
    expect(viaSelection.rawFlagCounts.length).toBeGreaterThan(0);
  });

  test("findings: a person downgrades a finding to a warning or mutes it, the critics replay the verdicts, the human review survives", async () => {
    // the second dataset of the recording block: two accepted, two rejected by gates (LAGGY, NOGRASP)
    const block = await testFetcher.get(app, `${base}/blocks/${blockId}`, token);
    const second = (block.jsonResponse.datasets as { id: string; name: string }[]).find((d) => d.name === "cup_tray_b")!;
    const before = await testFetcher.get(app, `${base}/datasets/${second.id}`, token);
    expect(before.jsonResponse.analysis.overrides).toEqual({ ignoreFlags: [], reviewFlags: [], disabledCritics: [] });
    // the critics of the run, as the spec configured them and with what they raised
    const critics_ = before.jsonResponse.analysis.critics as { id: string; kind: string; weight: number; gate: boolean; gateFlags: string[]; flags: { flag: string; count: number }[]; gatedEpisodes: number }[];
    expect(critics_.find((c) => c.id === "duplication")).toMatchObject({ kind: "hard", weight: 1, gate: true, gateFlags: ["LAGGY", "CAMSTALL"], flags: [{ flag: "LAGGY", count: 1 }], gatedEpisodes: 1 });
    expect(critics_.find((c) => c.id === "tracking_error")).toMatchObject({ weight: 1.5, gate: true });
    expect(critics_.find((c) => c.id === "vlm")).toMatchObject({ kind: "soft" });
    expect(before.jsonResponse.analysis.rawFlagCounts.map((f: { flag: string }) => f.flag).sort()).toEqual(["ACTION_SPIKES", "LAGGY", "NOGRASP"]);
    const ids = new Map((before.jsonResponse.episodes as { index: number; id: string }[]).map((e) => [e.index, e.id]));
    // a note on episode 2, written before the finding is downgraded: it must survive
    expect((await testFetcher.put(app, `${base}/skills/${skillId}/selection`, token, { changes: [{ episodeId: ids.get(2), selected: true }] })).status).toBe(200);

    // LAGGY becomes a warning, NOGRASP is muted
    const changed = await testFetcher.put(app, `${base}/datasets/${second.id}/findings`, token, { reviewFlags: ["LAGGY"], ignoreFlags: ["NOGRASP"] });
    expect(changed.status).toBe(200);
    expect(changed.jsonResponse.analysis.overrides).toEqual({ ignoreFlags: ["NOGRASP"], reviewFlags: ["LAGGY"], disabledCritics: [] });
    expect(changed.jsonResponse.analysis.counts).toEqual({ accept: 3, review: 1, reject: 0 });
    // the muted flag is gone from the run's flags but still listed as raised, so it can be given back
    expect(changed.jsonResponse.analysis.flagCounts.map((f: { flag: string }) => f.flag)).not.toContain("NOGRASP");
    expect(changed.jsonResponse.analysis.rawFlagCounts.map((f: { flag: string }) => f.flag)).toContain("NOGRASP");
    const eps = changed.jsonResponse.episodes as { id: string; index: number; verdict: string; selected: boolean; reason: { blocking: string[] } | null }[];
    // the rows kept their ids
    expect(eps.map((e) => e.id)).toEqual([0, 1, 2, 3].map((i) => ids.get(i)!));
    expect(eps.find((e) => e.index === 2)).toMatchObject({ verdict: "review", selected: true });
    expect(eps.find((e) => e.index === 2)!.reason!.blocking).toEqual(["LAGGY"]);
    // the muted gate is gone: accepted and back in the selection
    expect(eps.find((e) => e.index === 3)).toMatchObject({ verdict: "accept", selected: true, reason: null });
    expect((await testFetcher.get(app, `${base}/blocks/${blockId}`, token)).jsonResponse.totals).toMatchObject({ episodes: 8, accepted: 5, review: 1, rejected: 2 });
    // refused while the run is not done, and for an unknown dataset
    expect((await testFetcher.put(app, `${base}/datasets/00000000-0000-0000-0000-000000000000/findings`, token, { reviewFlags: ["LAGGY"] })).status).toBe(404);

    // the human review of a rollout survives the replay
    const rollouts = (await testFetcher.get(app, `${base}/blocks/${evalBlockId}/rollouts`, token)).jsonResponse.rollouts as { episodeId: string; index: number; humanVerdict: string | null; failureCode: string | null; variationSet: boolean }[];
    const reviewedBefore = rollouts.filter((r) => r.humanVerdict || r.failureCode);
    expect(reviewedBefore.length).toBeGreaterThan(0);
    const evalDataset = (await testFetcher.get(app, `${base}/blocks/${evalBlockId}`, token)).jsonResponse.datasets[0].id as string;
    expect((await testFetcher.put(app, `${base}/datasets/${evalDataset}/findings`, token, { ignoreFlags: ["LAGGY", "NOGRASP"] })).status).toBe(200);
    const after = (await testFetcher.get(app, `${base}/blocks/${evalBlockId}/rollouts`, token)).jsonResponse.rollouts as typeof rollouts;
    for (const r of reviewedBefore) expect(after.find((a) => a.episodeId === r.episodeId)).toMatchObject({ humanVerdict: r.humanVerdict, failureCode: r.failureCode, variationSet: r.variationSet });
    // and the report reads the new verdicts at once
    expect((await testFetcher.get(app, `${base}/evaluation-reports/${reportId}`, token)).jsonResponse.figures.overall.rollouts).toBe(4);
    expect((await testFetcher.put(app, `${base}/datasets/${evalDataset}/findings`, token, {})).jsonResponse.analysis.counts).toEqual({ accept: 2, review: 0, reject: 2 });

    // a critic switched off for this dataset: whatever it raised no longer counts
    const off = await testFetcher.put(app, `${base}/datasets/${second.id}/findings`, token, { disabledCritics: ["duplication"] });
    expect(off.status).toBe(200);
    expect(off.jsonResponse.analysis.overrides).toEqual({ ignoreFlags: [], reviewFlags: [], disabledCritics: ["duplication"] });
    expect((off.jsonResponse.episodes as { index: number; verdict: string }[]).find((e) => e.index === 2)!.verdict).toBe("accept");
    expect((off.jsonResponse.episodes as { index: number; verdict: string }[]).find((e) => e.index === 3)!.verdict).toBe("reject");

    // taking the overrides back restores the run as scored
    const restored = await testFetcher.put(app, `${base}/datasets/${second.id}/findings`, token, {});
    expect(restored.jsonResponse.analysis.overrides).toEqual({ ignoreFlags: [], reviewFlags: [], disabledCritics: [] });
    expect(restored.jsonResponse.analysis.counts).toEqual({ accept: 2, review: 0, reject: 2 });
    const back = restored.jsonResponse.episodes as { index: number; verdict: string; selected: boolean }[];
    expect(back.find((e) => e.index === 3)).toMatchObject({ verdict: "reject", selected: false });
    // episode 2 was a review before and is a reject again: out of the selection
    expect(back.find((e) => e.index === 2)).toMatchObject({ verdict: "reject", selected: false });
    const actions = (await testFetcher.get(app, `${base}/skills/${skillId}/audit`, token)).jsonResponse.map((a: { action: string }) => a.action);
    expect(actions).toContain("dataset.findings.changed");
    expect(actions).toContain("dataset.reanalysed");
  });

  test("continue on the next day, import from another skill", async () => {
    const cont = await testFetcher.post(app, `${base}/blocks`, token, { cellId, skillId, date: "2026-09-11" });
    expect(cont.status).toBe(201);
    expect(cont.jsonResponse.day.id).not.toBe(dayId);
    const block2 = cont.jsonResponse.block;
    // the newest recording block of the skill is carried over: brief and plan, fresh progress, no pictures
    expect(block2.sceneText).toContain("distractors");
    expect(block2.targetEpisodes).toBe(40);
    expect(block2.plan.steps).toHaveLength(2);
    expect(block2.plan.steps[0].variations[0].image).toBeNull();
    expect(block2.plan.steps[0].variations[0].imagePrompt).toContain("15 cm");
    expect(block2.progress).toBeNull();

    // a new skill in another cell imports the inputs of the first one
    const other = await testFetcher.post(app, `${base}/cells`, token, { name: "Cell 14" });
    const s2 = await testFetcher.post(app, `${base}/skills`, token, { name: "Cup to tray, left hand" });
    skill2Id = s2.jsonResponse.id;
    const b2 = await testFetcher.post(app, `${base}/blocks`, token, { cellId: other.jsonResponse.id, skillId: skill2Id, date: "2026-09-11" });
    expect(b2.status).toBe(201);
    expect(b2.jsonResponse.block.sceneText).toBe("");
    const imported = await testFetcher.post(app, `${base}/blocks/${b2.jsonResponse.block.id}/import`, token, { skillId });
    expect(imported.status).toBe(200);
    expect(imported.jsonResponse.sceneText).toContain("distractors");
    expect(imported.jsonResponse.plan.source).toBe("manual");
    expect(imported.jsonResponse.skill.taskDescription).toContain("cup");

    const list = await testFetcher.get(app, `${base}/skills?status=active`, token);
    expect(list.jsonResponse).toHaveLength(2);
    const mine = list.jsonResponse.find((s: { id: string }) => s.id === skillId);
    expect(mine.days).toBe(2);
    expect(mine.recordingBlocks).toBe(2);
    expect(mine.evaluationBlocks).toBe(1);
    expect(mine.episodes).toBe(8);
    expect(mine.acceptedEpisodes).toBe(4);
    expect(mine.lastDate).toBe("2026-09-11");
    // days by skill
    expect((await testFetcher.get(app, `${base}/days?skillId=${skillId}`, token)).jsonResponse).toHaveLength(2);
    expect((await testFetcher.get(app, `${base}/blocks?skillId=${skillId}&kind=evaluation`, token)).jsonResponse).toHaveLength(1);
  });

  test("a block is deleted with its datasets, the day stays; a day is deleted with its blocks", async () => {
    const other = (await testFetcher.get(app, `${base}/cells`, token)).jsonResponse.find((c: { name: string }) => c.name === "Cell 14");
    const started = await testFetcher.post(app, `${base}/blocks`, token, { cellId: other.id, skillId: skill2Id, date: "2026-09-12" });
    const day3 = started.jsonResponse.day.id as string;
    const block3 = started.jsonResponse.block.id as string;
    const up = await testFetcher.postFormData(app, `${base}/blocks/${block3}/datasets`, token, zipUpload("gone.zip"));
    expect(up.status).toBe(201);
    const jobId = up.jsonResponse.criticsJobId as string;

    expect((await testFetcher.delete(app, `${base}/blocks/${block3}`, token2)).status).toBe(403);
    expect((await testFetcher.delete(app, `${base}/blocks/${block3}`, token)).status).toBe(204);
    expect((await testFetcher.get(app, `${base}/blocks/${block3}`, token)).status).toBe(404);
    expect((await testFetcher.get(app, `${base}/datasets/${up.jsonResponse.id}`, token)).status).toBe(404);
    expect(critics.deleted).toContain(jobId);
    // the day is the cell's record and stays, empty
    const day = await testFetcher.get(app, `${base}/days/${day3}`, token);
    expect(day.status).toBe(200);
    expect(day.jsonResponse.blocks).toHaveLength(0);
    const audit = await testFetcher.get(app, `${base}/skills/${skill2Id}/audit`, token);
    const gone = audit.jsonResponse.find((a: { action: string }) => a.action === "block.deleted");
    expect(gone.details).toEqual({ kind: "recording", step: "review", datasets: ["gone"] });

    // the day with a block and a dataset
    const again = await testFetcher.post(app, `${base}/blocks`, token, { cellId: other.id, skillId: skill2Id, date: "2026-09-12" });
    expect(again.jsonResponse.day.id).toBe(day3);
    const block4 = again.jsonResponse.block.id as string;
    const up2 = await testFetcher.postFormData(app, `${base}/blocks/${block4}/datasets`, token, zipUpload("gone2.zip"));

    // a dataset removed from the block drops out of the analysis, the figures and the selection
    const extra = await testFetcher.postFormData(app, `${base}/blocks/${block4}/datasets`, token, zipUpload("wrong.zip"));
    expect(extra.status).toBe(201);
    const both = await testFetcher.get(app, `${base}/blocks/${block4}`, token);
    expect(both.jsonResponse.datasets).toHaveLength(2);
    const before = both.jsonResponse.totals.episodes as number;
    const selBefore = await testFetcher.get(app, `${base}/skills/${skill2Id}/selection`, token);
    expect(selBefore.jsonResponse.datasets.some((d: { dataset: { id: string } }) => d.dataset.id === extra.jsonResponse.id)).toBe(true);
    expect((await testFetcher.delete(app, `${base}/datasets/${extra.jsonResponse.id}`, token)).status).toBe(204);
    expect(critics.deleted).toContain(extra.jsonResponse.criticsJobId);
    const one = await testFetcher.get(app, `${base}/blocks/${block4}`, token);
    expect(one.jsonResponse.datasets.map((d: { id: string }) => d.id)).toEqual([up2.jsonResponse.id]);
    expect(one.jsonResponse.totals.episodes).toBeLessThan(before);
    const selAfter = await testFetcher.get(app, `${base}/skills/${skill2Id}/selection`, token);
    expect(selAfter.jsonResponse.datasets.some((d: { dataset: { id: string } }) => d.dataset.id === extra.jsonResponse.id)).toBe(false);
    expect(selAfter.jsonResponse.totals.episodes).toBe(selBefore.jsonResponse.totals.episodes - (before - one.jsonResponse.totals.episodes));
    const removedAudit = await testFetcher.get(app, `${base}/skills/${skill2Id}/audit`, token);
    const removedEntry = removedAudit.jsonResponse.find((a: { action: string }) => a.action === "dataset.deleted");
    expect(removedEntry.details).toEqual({ datasetId: extra.jsonResponse.id, name: "wrong" });

    expect((await testFetcher.delete(app, `${base}/days/${day3}`, token)).status).toBe(204);
    expect((await testFetcher.get(app, `${base}/days/${day3}`, token)).status).toBe(404);
    expect((await testFetcher.get(app, `${base}/blocks/${again.jsonResponse.block.id}`, token)).status).toBe(404);
    expect(critics.deleted).toContain(up2.jsonResponse.criticsJobId);
    expect((await testFetcher.get(app, `${base}/skills/${skill2Id}`, token)).jsonResponse.days).toBe(1);
  });

  test("print view, kpis, audit, close", async () => {
    const print = await app.request(`/public/gym/print/${shareId}`);
    expect(print.status).toBe(200);
    const view = (await print.json()) as {
      cell: { name: string };
      blocks: { id: string; kind: string; skill: { name: string }; policyName: string | null; datasets: { accepted: number; specName: string }[] }[];
      totals: { episodes: number };
      evaluation: { episodes: number };
      times: { downtimeMinutes: number };
    };
    expect(view.cell.name).toBe("Cell 13");
    expect(view.blocks).toHaveLength(2);
    expect(view.blocks[0]!.kind).toBe("recording");
    expect(view.blocks[0]!.skill.name).toBe("Cup to tray");
    expect(view.blocks[0]!.datasets).toHaveLength(2);
    expect(view.blocks[0]!.datasets[0]!.accepted).toBe(2);
    expect(view.blocks[0]!.datasets[0]!.specName).toBe("cup_tray");
    expect(view.blocks[1]!.kind).toBe("evaluation");
    expect(view.blocks[1]!.policyName).toBe("v1");
    expect(view.totals.episodes).toBe(8);
    expect(view.evaluation.episodes).toBe(4);
    expect(view.times.downtimeMinutes).toBe(10);
    expect((await app.request(`/public/gym/print/${shareId}/blocks/${view.blocks[0]!.id}/scene-image`)).status).toBe(200);
    expect((await app.request(`/public/gym/print/${shareId}/blocks/${evalBlockId}/scene-image`)).status).toBe(404);
    expect((await app.request(`/public/gym/print/nope-nope-nope`)).status).toBe(404);

    const kpis = await testFetcher.get(app, `${base}/kpis?from=2026-09-01&to=2026-09-30`, token);
    expect(kpis.status).toBe(200);
    expect(kpis.jsonResponse.totals.episodes).toBe(8);
    expect(kpis.jsonResponse.totals.accepted).toBe(4);
    expect(kpis.jsonResponse.totals.rejected).toBe(4);
    expect(kpis.jsonResponse.totals.acceptRatePercent).toBe(50);
    expect(kpis.jsonResponse.totals.datasets).toBe(2);
    expect(kpis.jsonResponse.totals.days).toBe(3);
    expect(kpis.jsonResponse.totals.blocks).toBe(4);
    expect(kpis.jsonResponse.totals.skills).toBe(2);
    expect(kpis.jsonResponse.totals.downtimeMinutes).toBe(10);
    // 3 of 4: the human review of one rollout counts over the critics' verdict
    expect(kpis.jsonResponse.totals.evaluation).toMatchObject({ blocks: 1, episodes: 4, accepted: 3, successRatePercent: 75 });
    expect(kpis.jsonResponse.perCell).toHaveLength(2);
    expect(kpis.jsonResponse.perDay.find((d: { date: string }) => d.date === "2026-09-10").blocks).toBe(2);
    expect(kpis.jsonResponse.flags.map((f: { flag: string }) => f.flag)).toContain("LAGGY");
    const byCell = await testFetcher.get(app, `${base}/kpis?cellId=${cellId}`, token);
    expect(byCell.jsonResponse.totals.skills).toBe(1);
    const bySkill = await testFetcher.get(app, `${base}/kpis?skillId=${skill2Id}`, token);
    expect(bySkill.jsonResponse.totals.blocks).toBe(1);
    expect(bySkill.jsonResponse.totals.episodes).toBe(0);

    const audit = await testFetcher.get(app, `${base}/skills/${skillId}/audit`, token);
    const actions = audit.jsonResponse.map((a: { action: string }) => a.action);
    for (const a of ["skill.created", "block.started", "block.scene.captured", "block.plan.generated", "block.recording.started", "dataset.uploaded", "dataset.analysed", "selection.updated", "export.created", "policy.created", "evaluation.reviewed", "evaluation.report.created", "evaluation.report.updated"]) {
      expect(actions).toContain(a);
    }
    expect(audit.jsonResponse.find((a: { action: string }) => a.action === "skill.created").userName).toBeTruthy();
    const dayAudit = await testFetcher.get(app, `${base}/days/${dayId}/audit`, token);
    expect(dayAudit.jsonResponse.map((a: { action: string }) => a.action)).toContain("day.downtime.added");
    expect(dayAudit.jsonResponse.map((a: { action: string }) => a.action)).toContain("dataset.uploaded");

    const closedBlock = await testFetcher.post(app, `${base}/blocks/${blockId}/close`, token, {});
    expect(closedBlock.jsonResponse.step).toBe("closed");
    // the mobile token dies with the block
    expect((await app.request(`/public/gym/m/${mobileToken}`)).status).toBe(410);
    expect((await testFetcher.get(app, `${base}/blocks/${blockId}/access-token`, token)).status).toBe(409);
    // reopening
    expect((await testFetcher.put(app, `${base}/blocks/${blockId}/step`, token, { step: "review" })).jsonResponse.closedAt).toBeNull();

    // closing the day closes its open blocks
    const closedDay = await testFetcher.post(app, `${base}/days/${dayId}/close`, token, {});
    expect(closedDay.jsonResponse.closedAt).toBeTruthy();
    expect(closedDay.jsonResponse.open).toBe(false);
    expect(closedDay.jsonResponse.blocks.every((b: { step: string }) => b.step === "closed")).toBe(true);
    // a new block on a closed day reopens it
    const re = await testFetcher.post(app, `${base}/blocks`, token, { cellId, skillId, date: "2026-09-10" });
    expect(re.jsonResponse.day.closedAt).toBeNull();

    // archiving a skill
    expect((await testFetcher.put(app, `${base}/skills/${skill2Id}`, token, { status: "archived" })).jsonResponse.status).toBe("archived");
    expect((await testFetcher.get(app, `${base}/skills?status=active`, token)).jsonResponse).toHaveLength(1);
    // a cell with day protocols cannot be deleted, only deactivated
    expect((await testFetcher.delete(app, `${base}/cells/${cellId}`, token)).status).toBe(409);
    expect((await testFetcher.put(app, `${base}/cells/${cellId}`, token, { active: false })).jsonResponse.active).toBe(false);
    expect((await testFetcher.post(app, `${base}/blocks`, token, { cellId, skillId, date: "2026-09-13" })).status).toBe(400);
    // deleting a dataset asks the critics service to drop its job
    expect((await testFetcher.delete(app, `${base}/datasets/${datasetId}`, token)).status).toBe(204);
    expect(critics.deleted).toContain("job_1");
    // a report goes on its own; the blocks stay
    expect((await testFetcher.delete(app, `${base}/evaluation-reports/${reportId}`, token)).status).toBe(204);
    expect((await testFetcher.get(app, `${base}/evaluation-reports/${reportId}`, token)).status).toBe(404);
    expect((await testFetcher.get(app, `${base}/blocks/${evalBlockId}`, token)).status).toBe(200);
    // deleting the skill takes its blocks; the day protocol stays
    expect((await testFetcher.delete(app, `${base}/skills/${skillId}`, token)).status).toBe(204);
    expect((await testFetcher.get(app, `${base}/blocks/${evalBlockId}`, token)).status).toBe(404);
    const day = await testFetcher.get(app, `${base}/days/${dayId}`, token);
    expect(day.status).toBe(200);
    expect(day.jsonResponse.blocks).toHaveLength(0);
  }, 20_000);
});
