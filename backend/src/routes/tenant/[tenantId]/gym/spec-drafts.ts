/**
 * The spec wizard: drafts of a critics spec, worked out from a sample dataset
 * (lib/gym/spec-drafts.ts).
 *
 *   GET    /tenant/:tenantId/gym/spec-drafts                     the open drafts
 *   POST   /tenant/:tenantId/gym/spec-drafts                     { name?, skillId?, purpose?, episodes? } start one; episodes like "0-9" or "1-3,6,8"
 *   GET    /tenant/:tenantId/gym/spec-drafts/:id                 the draft, brought up to date with its runs
 *   PUT    /tenant/:tenantId/gym/spec-drafts/:id                 { name?, skillId?, purpose?, episodes?, step?, spec?, judgments? } save what was entered
 *   DELETE /tenant/:tenantId/gym/spec-drafts/:id                 discard: the sample and the runs go, nothing is stored
 *   POST   /tenant/:tenantId/gym/spec-drafts/:id/analyze         run the auto mode over the sample again (after the pick of episodes changed)
 *   POST   /tenant/:tenantId/gym/spec-drafts/:id/test            { spec?, episodes? } test run with the drafted spec, over the analysed episodes or the picked ones
 *   POST   /tenant/:tenantId/gym/spec-drafts/:id/finish          { name, assignToSkill?, overwrite? } store the spec, name it on the skill
 *   GET    /tenant/:tenantId/gym/spec-drafts/:id/report?run      the report of the analysis or the test run
 *   GET    /tenant/:tenantId/gym/spec-drafts/:id/files/*?run     contact sheets of the sample (proxied)
 *   POST   /tenant/:tenantId/gym/spec-drafts/:id/episodes        { episodes } analyse more episodes, picked like "57" or "40-42"
 *   GET    /tenant/:tenantId/gym/spec-drafts/:id/episodes/:episode/videos          the camera videos of an episode
 *   GET    /tenant/:tenantId/gym/spec-drafts/:id/episodes/:episode/video?camera    one of them, streamed (range requests)
 *
 *   the sample, uploaded in chunks like a dataset (lib/gym/dataset-uploads.ts):
 *   GET    /tenant/:tenantId/gym/spec-drafts/:id/uploads
 *   POST   /tenant/:tenantId/gym/spec-drafts/:id/uploads                          { fileName, bytes }
 *   GET    /tenant/:tenantId/gym/spec-drafts/:id/uploads/:uploadId
 *   PUT    /tenant/:tenantId/gym/spec-drafts/:id/uploads/:uploadId/chunks/:index  the chunk itself as the body
 *   POST   /tenant/:tenantId/gym/spec-drafts/:id/uploads/:uploadId/complete       the chunks become the sample, the analysis starts
 *   DELETE /tenant/:tenantId/gym/spec-drafts/:id/uploads/:uploadId
 */
import type { SymbiosikaFrameworkHonoApp } from "@framework/types";
import { authAndSetUsersInfo, checkUserPermission } from "@framework/lib/utils/hono-middlewares";
import { isTenantMember } from "@framework/routes/tenant";
import { HTTPException } from "hono/http-exception";
import { describeRoute, validator } from "hono-openapi";
import * as v from "valibot";
import { criticsClient } from "../../../../lib/critics/client";
import { abortUpload, beginUpload, getUpload, listUploads, putChunk } from "../../../../lib/gym/dataset-uploads";
import {
  addEpisode,
  assertSpecDraft,
  episodeVideo,
  episodeVideos,
  completeSampleUpload,
  createSpecDraft,
  deleteSpecDraft,
  finishSpecDraft,
  getSpecDraft,
  getSpecDraftReport,
  listSpecDrafts,
  RUNS,
  specDraftJob,
  startAnalysis,
  startTest,
  updateSpecDraft,
} from "../../../../lib/gym/spec-drafts";
import { actorOf, ok, tenantIdParam, tenantParam, toHttpError } from "./_shared";

const beginUploadSchema = v.object({
  fileName: v.pipe(v.string(), v.minLength(1), v.maxLength(300)),
  bytes: v.pipe(v.number(), v.integer(), v.minValue(1)),
});

const uploadParam = v.object({
  tenantId: v.pipe(v.string(), v.uuid()),
  id: v.pipe(v.string(), v.uuid()),
  uploadId: v.pipe(v.string(), v.uuid()),
});

const chunkParam = v.object({
  tenantId: v.pipe(v.string(), v.uuid()),
  id: v.pipe(v.string(), v.uuid()),
  uploadId: v.pipe(v.string(), v.uuid()),
  index: v.pipe(v.string(), v.transform(Number), v.number(), v.integer(), v.minValue(0), v.maxValue(100000)),
});

const runQuery = v.object({ run: v.optional(v.picklist(RUNS), "analysis") });

const episodeParam = v.object({
  tenantId: v.pipe(v.string(), v.uuid()),
  id: v.pipe(v.string(), v.uuid()),
  episode: v.pipe(v.string(), v.regex(/^\d{1,7}$/), v.transform(Number)),
});

/** The headers of a video answer a player needs to seek, passed on as the critics sent them. */
const VIDEO_HEADERS = ["content-type", "content-length", "content-range", "accept-ranges"] as const;

export default function defineSpecDraftRoutes(app: SymbiosikaFrameworkHonoApp, API_BASE_PATH = "") {
  const base = `${API_BASE_PATH}/tenant/:tenantId/gym/spec-drafts`;
  const guard = [authAndSetUsersInfo, checkUserPermission] as const;

  app.get(base, ...guard,
    describeRoute({ tags: ["gym"], summary: "The open drafts of the spec wizard", responses: ok }),
    validator("param", tenantParam), isTenantMember,
    async (c) => {
      try {
        return c.json(await listSpecDrafts(c.req.valid("param").tenantId));
      } catch (e) { throw toHttpError(e); }
    });

  app.post(base, ...guard,
    describeRoute({ tags: ["gym"], summary: "Start the spec wizard", responses: ok }),
    validator("param", tenantParam), isTenantMember,
    async (c) => {
      try {
        const { tenantId } = c.req.valid("param");
        return c.json(await createSpecDraft(tenantId, await actorOf(c), await c.req.json().catch(() => ({}))), 201);
      } catch (e) { throw toHttpError(e); }
    });

  app.get(`${base}/:id`, ...guard,
    describeRoute({ tags: ["gym"], summary: "One spec draft, up to date with its critics runs", responses: ok }),
    validator("param", tenantIdParam), isTenantMember,
    async (c) => {
      try {
        const { tenantId, id } = c.req.valid("param");
        return c.json(await getSpecDraft(tenantId, id));
      } catch (e) { throw toHttpError(e); }
    });

  app.put(`${base}/:id`, ...guard,
    describeRoute({ tags: ["gym"], summary: "Save the inputs of the spec wizard", responses: ok }),
    validator("param", tenantIdParam), isTenantMember,
    async (c) => {
      try {
        const { tenantId, id } = c.req.valid("param");
        return c.json(await updateSpecDraft(tenantId, id, await c.req.json()));
      } catch (e) { throw toHttpError(e); }
    });

  app.delete(`${base}/:id`, ...guard,
    describeRoute({ tags: ["gym"], summary: "Discard a spec draft with its sample", responses: ok }),
    validator("param", tenantIdParam), isTenantMember,
    async (c) => {
      try {
        const { tenantId, id } = c.req.valid("param");
        await deleteSpecDraft(tenantId, id);
        return c.body(null, 204);
      } catch (e) { throw toHttpError(e); }
    });

  app.post(`${base}/:id/analyze`, ...guard,
    describeRoute({ tags: ["gym"], summary: "Run the critics in auto mode over the sample", responses: ok }),
    validator("param", tenantIdParam), isTenantMember,
    async (c) => {
      try {
        const { tenantId, id } = c.req.valid("param");
        return c.json(await startAnalysis(tenantId, id));
      } catch (e) { throw toHttpError(e); }
    });

  app.post(`${base}/:id/test`, ...guard,
    describeRoute({ tags: ["gym"], summary: "Test the drafted spec on the sample", responses: ok }),
    validator("param", tenantIdParam), isTenantMember,
    async (c) => {
      try {
        const { tenantId, id } = c.req.valid("param");
        return c.json(await startTest(tenantId, id, await c.req.json().catch(() => ({}))));
      } catch (e) { throw toHttpError(e); }
    });

  app.post(`${base}/:id/finish`, ...guard,
    describeRoute({ tags: ["gym"], summary: "Store the drafted spec and name it on the skill", responses: ok }),
    validator("param", tenantIdParam), isTenantMember,
    async (c) => {
      try {
        const { tenantId, id } = c.req.valid("param");
        return c.json(await finishSpecDraft(tenantId, await actorOf(c), id, await c.req.json()));
      } catch (e) { throw toHttpError(e); }
    });

  app.get(`${base}/:id/report`, ...guard,
    describeRoute({ tags: ["gym"], summary: "The report of the analysis or the test run of a spec draft", responses: ok }),
    validator("param", tenantIdParam), validator("query", runQuery), isTenantMember,
    async (c) => {
      try {
        const { tenantId, id } = c.req.valid("param");
        return c.json(await getSpecDraftReport(tenantId, id, c.req.valid("query").run));
      } catch (e) { throw toHttpError(e); }
    });

  app.get(`${base}/:id/files/*`, ...guard,
    describeRoute({ tags: ["gym"], summary: "An artifact of a run of a spec draft (contact sheet)", responses: ok }),
    validator("param", tenantIdParam), validator("query", runQuery), isTenantMember,
    async (c) => {
      try {
        const { tenantId, id } = c.req.valid("param");
        const path = c.req.path.split(`/files/`).slice(1).join("/files/");
        if (!path || path.includes("..")) throw new HTTPException(400, { message: "Invalid path" });
        // the sheet of an episode picked by number lies with the run over that episode
        const episode = /episode_(\d+)\./.exec(path)?.[1];
        const jobId = await specDraftJob(tenantId, id, c.req.valid("query").run, episode ? Number(episode) : undefined);
        const upstream = await criticsClient.file(jobId, path);
        return new Response(upstream.body, {
          status: 200,
          headers: { "Content-Type": upstream.headers.get("content-type") ?? "application/octet-stream", "Cache-Control": "private, max-age=300" },
        });
      } catch (e) { throw toHttpError(e); }
    });

  app.post(`${base}/:id/episodes`, ...guard,
    describeRoute({ tags: ["gym"], summary: "Analyse more episodes of the sample, picked by number", responses: ok }),
    validator("param", tenantIdParam), isTenantMember,
    async (c) => {
      try {
        const { tenantId, id } = c.req.valid("param");
        return c.json(await addEpisode(tenantId, id, await c.req.json()));
      } catch (e) { throw toHttpError(e); }
    });

  app.get(`${base}/:id/episodes/:episode/videos`, ...guard,
    describeRoute({ tags: ["gym"], summary: "The camera videos of an episode of the sample", responses: ok }),
    validator("param", episodeParam), isTenantMember,
    async (c) => {
      try {
        const { tenantId, id, episode } = c.req.valid("param");
        return c.json(await episodeVideos(tenantId, id, episode));
      } catch (e) { throw toHttpError(e); }
    });

  app.get(`${base}/:id/episodes/:episode/video`, ...guard,
    describeRoute({ tags: ["gym"], summary: "One camera video of an episode of the sample, streamed with range requests", responses: ok }),
    validator("param", episodeParam), validator("query", v.object({ camera: v.pipe(v.string(), v.minLength(1), v.maxLength(300)) })), isTenantMember,
    async (c) => {
      try {
        const { tenantId, id, episode } = c.req.valid("param");
        const upstream = await episodeVideo(tenantId, id, episode, c.req.valid("query").camera, c.req.header("range"));
        const headers = new Headers({ "Cache-Control": "private, max-age=300" });
        for (const name of VIDEO_HEADERS) {
          const value = upstream.headers.get(name);
          if (value) headers.set(name, value);
        }
        return new Response(upstream.body, { status: upstream.status, headers });
      } catch (e) { throw toHttpError(e); }
    });

  app.get(`${base}/:id/uploads`, ...guard,
    describeRoute({ tags: ["gym"], summary: "The sample uploads of a spec draft that are still open", responses: ok }),
    validator("param", tenantIdParam), isTenantMember,
    async (c) => {
      try {
        const { tenantId, id } = c.req.valid("param");
        await assertSpecDraft(tenantId, id);
        return c.json(await listUploads(tenantId, { specDraftId: id }));
      } catch (e) { throw toHttpError(e); }
    });

  app.post(`${base}/:id/uploads`, ...guard,
    describeRoute({ tags: ["gym"], summary: "Announce the sample dataset of a spec draft, to upload in chunks", responses: ok }),
    validator("param", tenantIdParam), isTenantMember,
    async (c) => {
      try {
        const { tenantId, id } = c.req.valid("param");
        await assertSpecDraft(tenantId, id);
        const { fileName, bytes } = v.parse(beginUploadSchema, await c.req.json());
        return c.json(await beginUpload(tenantId, await actorOf(c), { specDraftId: id }, { fileName, bytes }), 201);
      } catch (e) { throw toHttpError(e); }
    });

  app.get(`${base}/:id/uploads/:uploadId`, ...guard,
    describeRoute({ tags: ["gym"], summary: "Which chunks of the sample arrived, to resume", responses: ok }),
    validator("param", uploadParam), isTenantMember,
    async (c) => {
      try {
        const { tenantId, id, uploadId } = c.req.valid("param");
        return c.json(await getUpload(tenantId, { specDraftId: id }, uploadId));
      } catch (e) { throw toHttpError(e); }
    });

  app.put(`${base}/:id/uploads/:uploadId/chunks/:index`, ...guard,
    describeRoute({ tags: ["gym"], summary: "Store one chunk of the sample", responses: ok }),
    validator("param", chunkParam), isTenantMember,
    async (c) => {
      try {
        const { tenantId, id, uploadId, index } = c.req.valid("param");
        return c.json(await putChunk(tenantId, { specDraftId: id }, uploadId, index, await c.req.arrayBuffer()));
      } catch (e) { throw toHttpError(e); }
    });

  app.post(`${base}/:id/uploads/:uploadId/complete`, ...guard,
    describeRoute({ tags: ["gym"], summary: "The sample is complete: analyse it in auto mode", responses: ok }),
    validator("param", uploadParam), isTenantMember,
    async (c) => {
      try {
        const { tenantId, id, uploadId } = c.req.valid("param");
        return c.json(await completeSampleUpload(tenantId, id, uploadId), 201);
      } catch (e) { throw toHttpError(e); }
    });

  app.delete(`${base}/:id/uploads/:uploadId`, ...guard,
    describeRoute({ tags: ["gym"], summary: "Give up a sample upload and drop its chunks", responses: ok }),
    validator("param", uploadParam), isTenantMember,
    async (c) => {
      try {
        const { tenantId, id, uploadId } = c.req.valid("param");
        await abortUpload(tenantId, { specDraftId: id }, uploadId);
        return c.body(null, 204);
      } catch (e) { throw toHttpError(e); }
    });
}
