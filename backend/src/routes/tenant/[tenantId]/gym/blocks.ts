/**
 * Blocks: the operator wizard of one block, and the datasets of a block.
 *
 *   GET    /tenant/:tenantId/gym/blocks?skillId&dayProtocolId&kind&limit
 *   POST   /tenant/:tenantId/gym/blocks                      { cellId, skillId, kind?, policyId?, date? } start a block (creates the day when missing)
 *   GET    /tenant/:tenantId/gym/blocks/:id
 *   DELETE /tenant/:tenantId/gym/blocks/:id                  with its datasets; the day stays
 *   PUT    /tenant/:tenantId/gym/blocks/:id/brief            { sceneText?, targetEpisodes?, kind?, policyId? }
 *   POST   /tenant/:tenantId/gym/blocks/:id/import           { skillId } copy inputs from another skill
 *   PUT    /tenant/:tenantId/gym/blocks/:id/step             { step }
 *   POST   /tenant/:tenantId/gym/blocks/:id/close
 *   GET    /tenant/:tenantId/gym/blocks/:id/access-token     token and URLs for the mobile views
 *   GET    /tenant/:tenantId/gym/blocks/:id/scene-image
 *   POST   /tenant/:tenantId/gym/blocks/:id/scene-image      multipart "file"
 *   DELETE /tenant/:tenantId/gym/blocks/:id/scene-image
 *   POST   /tenant/:tenantId/gym/blocks/:id/plan/generate?lang
 *   PUT    /tenant/:tenantId/gym/blocks/:id/plan
 *
 *   the optional reference image of one variation of the plan (:stepId and the
 *   index of the variation inside its step):
 *   GET    /tenant/:tenantId/gym/blocks/:id/plan/steps/:stepId/variations/:index/image
 *   POST   /tenant/:tenantId/gym/blocks/:id/plan/steps/:stepId/variations/:index/image/generate
 *   POST   /tenant/:tenantId/gym/blocks/:id/plan/steps/:stepId/variations/:index/image/from-scene
 *   POST   /tenant/:tenantId/gym/blocks/:id/plan/steps/:stepId/variations/:index/image   multipart "file"
 *   DELETE /tenant/:tenantId/gym/blocks/:id/plan/steps/:stepId/variations/:index/image
 *   POST   /tenant/:tenantId/gym/blocks/:id/recording/start[?withoutPlan=true]
 *   PUT    /tenant/:tenantId/gym/blocks/:id/recording/progress { stepId, delta }
 *   PUT    /tenant/:tenantId/gym/blocks/:id/recording/current-step { stepId } work on this step next
 *   POST   /tenant/:tenantId/gym/blocks/:id/recording/finish
 *   POST   /tenant/:tenantId/gym/blocks/:id/datasets         multipart "file": zipped LeRobot dataset (+ name)
 *
 *   the same upload in chunks, for datasets too large for one request (see
 *   lib/gym/dataset-uploads.ts: a proxy in front of the app kills a request
 *   that carries the whole archive):
 *   GET    /tenant/:tenantId/gym/blocks/:id/datasets/uploads              the open uploads of the block
 *   POST   /tenant/:tenantId/gym/blocks/:id/datasets/uploads              { fileName, bytes, name? } announce one
 *   GET    /tenant/:tenantId/gym/blocks/:id/datasets/uploads/:uploadId    what is missing, to resume
 *   PUT    /tenant/:tenantId/gym/blocks/:id/datasets/uploads/:uploadId/chunks/:index   the chunk itself as the body
 *   POST   /tenant/:tenantId/gym/blocks/:id/datasets/uploads/:uploadId/complete        assemble and analyse
 *   DELETE /tenant/:tenantId/gym/blocks/:id/datasets/uploads/:uploadId    give up, drop the chunks
 *   POST   /tenant/:tenantId/gym/blocks/:id/follow-up?lang
 *   GET    /tenant/:tenantId/gym/datasets/:id
 *   DELETE /tenant/:tenantId/gym/datasets/:id
 */
import type { SymbiosikaFrameworkHonoApp } from "@framework/types";
import { authAndSetUsersInfo, checkUserPermission } from "@framework/lib/utils/hono-middlewares";
import { isTenantMember } from "@framework/routes/tenant";
import { HTTPException } from "hono/http-exception";
import { describeRoute, validator } from "hono-openapi";
import * as v from "valibot";
import { BLOCK_KINDS } from "../../../../db/schema";
import {
  abortUpload,
  beginUpload,
  completeUpload,
  getUpload,
  listUploads,
  putChunk,
} from "../../../../lib/gym/dataset-uploads";
import { deleteDataset, getDataset, uploadDataset } from "../../../../lib/gym/datasets";
import { toDayView } from "../../../../lib/gym/day-protocols";
import {
  closeBlock,
  currentStepSchema,
  deleteBlock,
  ensureAccessToken,
  finishRecording,
  generatePlan,
  generateVariationImage,
  getBlock,
  getBlockRow,
  getSceneImage,
  getVariationImage,
  importFromSkill,
  listBlocks,
  progressSchema,
  recordProgress,
  removeSceneImage,
  removeVariationImage,
  setCurrentStep,
  setSceneImage,
  setStep,
  setVariationImage,
  startBlock,
  startRecording,
  stepSchema,
  suggestFollowUp,
  toBlockView,
  updateBrief,
  updatePlan,
  useSceneImageForVariation,
} from "../../../../lib/gym/blocks";
import { actorOf, langQuery, ok, tenantIdParam, tenantParam, toHttpError } from "./_shared";

const listQuery = v.object({
  skillId: v.optional(v.pipe(v.string(), v.uuid())),
  dayProtocolId: v.optional(v.pipe(v.string(), v.uuid())),
  kind: v.optional(v.picklist(BLOCK_KINDS)),
  limit: v.optional(v.pipe(v.string(), v.transform(Number), v.number(), v.integer(), v.minValue(1), v.maxValue(5000))),
});

/** One variation of the plan: its step and its index inside that step. */
const variationParam = v.object({
  tenantId: v.pipe(v.string(), v.uuid()),
  id: v.pipe(v.string(), v.uuid()),
  stepId: v.pipe(v.string(), v.minLength(1), v.maxLength(100)),
  index: v.pipe(v.string(), v.transform(Number), v.number(), v.integer(), v.minValue(0), v.maxValue(1000)),
});

/** The file a chunked upload will carry, announced before anything is transferred. */
const beginUploadSchema = v.object({
  fileName: v.pipe(v.string(), v.minLength(1), v.maxLength(300)),
  bytes: v.pipe(v.number(), v.integer(), v.minValue(1)),
  name: v.optional(v.pipe(v.string(), v.maxLength(300))),
});

const uploadParam = v.object({
  tenantId: v.pipe(v.string(), v.uuid()),
  id: v.pipe(v.string(), v.uuid()),
  uploadId: v.pipe(v.string(), v.uuid()),
});

/** One chunk of an upload: its upload and its index in it. */
const chunkParam = v.object({
  tenantId: v.pipe(v.string(), v.uuid()),
  id: v.pipe(v.string(), v.uuid()),
  uploadId: v.pipe(v.string(), v.uuid()),
  index: v.pipe(v.string(), v.transform(Number), v.number(), v.integer(), v.minValue(0), v.maxValue(100000)),
});

/** Public paths of the mobile views, relative to the app origin (see frontend router). */
export const mobilePaths = (token: string) => ({
  capture: `/static/app/#/m/capture/${token}`,
  run: `/static/app/#/m/run/${token}`,
});

export default function defineBlockRoutes(app: SymbiosikaFrameworkHonoApp, API_BASE_PATH = "") {
  const base = `${API_BASE_PATH}/tenant/:tenantId/gym/blocks`;
  const dsBase = `${API_BASE_PATH}/tenant/:tenantId/gym/datasets`;
  const guard = [authAndSetUsersInfo, checkUserPermission] as const;

  app.get(base, ...guard,
    describeRoute({ tags: ["gym"], summary: "List blocks", responses: ok }),
    validator("param", tenantParam), validator("query", listQuery), isTenantMember,
    async (c) => {
      try {
        return c.json(await listBlocks(c.req.valid("param").tenantId, c.req.valid("query")));
      } catch (e) { throw toHttpError(e); }
    });

  app.post(base, ...guard,
    describeRoute({ tags: ["gym"], summary: "Start a block in a cell for a skill", responses: ok }),
    validator("param", tenantParam), isTenantMember,
    async (c) => {
      try {
        const { tenantId } = c.req.valid("param");
        const { day, block } = await startBlock(tenantId, await actorOf(c), await c.req.json());
        return c.json({ day: await toDayView(day), block: await toBlockView(block) }, 201);
      } catch (e) { throw toHttpError(e); }
    });

  app.get(`${base}/:id`, ...guard,
    describeRoute({ tags: ["gym"], summary: "One block", responses: ok }),
    validator("param", tenantIdParam), isTenantMember,
    async (c) => {
      try {
        const { tenantId, id } = c.req.valid("param");
        return c.json(await getBlock(tenantId, id));
      } catch (e) { throw toHttpError(e); }
    });

  app.delete(`${base}/:id`, ...guard,
    describeRoute({ tags: ["gym"], summary: "Delete a block with its datasets", responses: ok }),
    validator("param", tenantIdParam), isTenantMember,
    async (c) => {
      try {
        const { tenantId, id } = c.req.valid("param");
        await deleteBlock(tenantId, await actorOf(c), id);
        return c.body(null, 204);
      } catch (e) { throw toHttpError(e); }
    });

  app.put(`${base}/:id/brief`, ...guard,
    describeRoute({ tags: ["gym"], summary: "Update the scene brief", responses: ok }),
    validator("param", tenantIdParam), isTenantMember,
    async (c) => {
      try {
        const { tenantId, id } = c.req.valid("param");
        return c.json(await updateBrief(tenantId, await actorOf(c), id, await c.req.json()));
      } catch (e) { throw toHttpError(e); }
    });

  app.post(`${base}/:id/import`, ...guard,
    describeRoute({ tags: ["gym"], summary: "Import inputs from another skill", responses: ok }),
    validator("param", tenantIdParam), isTenantMember,
    async (c) => {
      try {
        const { tenantId, id } = c.req.valid("param");
        const body = v.parse(v.object({ skillId: v.pipe(v.string(), v.uuid()) }), await c.req.json());
        return c.json(await importFromSkill(tenantId, await actorOf(c), id, body.skillId));
      } catch (e) { throw toHttpError(e); }
    });

  app.put(`${base}/:id/step`, ...guard,
    describeRoute({ tags: ["gym"], summary: "Move the wizard to a step", responses: ok }),
    validator("param", tenantIdParam), isTenantMember,
    async (c) => {
      try {
        const { tenantId, id } = c.req.valid("param");
        const { step } = v.parse(stepSchema, await c.req.json());
        return c.json(await setStep(tenantId, await actorOf(c), id, step));
      } catch (e) { throw toHttpError(e); }
    });

  app.post(`${base}/:id/close`, ...guard,
    describeRoute({ tags: ["gym"], summary: "Close the block", responses: ok }),
    validator("param", tenantIdParam), isTenantMember,
    async (c) => {
      try {
        const { tenantId, id } = c.req.valid("param");
        return c.json(await closeBlock(tenantId, await actorOf(c), id));
      } catch (e) { throw toHttpError(e); }
    });

  app.get(`${base}/:id/access-token`, ...guard,
    describeRoute({ tags: ["gym"], summary: "Token and links of the mobile views", responses: ok }),
    validator("param", tenantIdParam), isTenantMember,
    async (c) => {
      try {
        const { tenantId, id } = c.req.valid("param");
        const info = await ensureAccessToken(tenantId, id);
        return c.json({ ...info, paths: mobilePaths(info.token) });
      } catch (e) { throw toHttpError(e); }
    });

  app.get(`${base}/:id/scene-image`, ...guard,
    describeRoute({ tags: ["gym"], summary: "The scene photo", responses: ok }),
    validator("param", tenantIdParam), isTenantMember,
    async (c) => {
      try {
        const { tenantId, id } = c.req.valid("param");
        const file = await getSceneImage(await getBlockRow(tenantId, id));
        if (!file) throw new HTTPException(404, { message: "No scene image" });
        return c.body(await file.arrayBuffer(), 200, { "Content-Type": file.type || "image/jpeg", "Cache-Control": "private, max-age=60" });
      } catch (e) { throw toHttpError(e); }
    });

  app.post(`${base}/:id/scene-image`, ...guard,
    describeRoute({ tags: ["gym"], summary: "Replace the scene photo", responses: ok }),
    validator("param", tenantIdParam), isTenantMember,
    async (c) => {
      try {
        const { tenantId, id } = c.req.valid("param");
        const body = await c.req.parseBody();
        const file = body["file"];
        if (!(file instanceof File)) throw new HTTPException(400, { message: "Multipart field 'file' is required" });
        return c.json(await toBlockView(await setSceneImage(await getBlockRow(tenantId, id), file, await actorOf(c))));
      } catch (e) { throw toHttpError(e); }
    });

  app.delete(`${base}/:id/scene-image`, ...guard,
    describeRoute({ tags: ["gym"], summary: "Remove the scene photo", responses: ok }),
    validator("param", tenantIdParam), isTenantMember,
    async (c) => {
      try {
        const { tenantId, id } = c.req.valid("param");
        return c.json(await removeSceneImage(tenantId, await actorOf(c), id));
      } catch (e) { throw toHttpError(e); }
    });

  app.post(`${base}/:id/plan/generate`, ...guard,
    describeRoute({ tags: ["gym"], summary: "Let the AI propose a plan", responses: ok }),
    validator("param", tenantIdParam), validator("query", langQuery), isTenantMember,
    async (c) => {
      try {
        const { tenantId, id } = c.req.valid("param");
        return c.json(await generatePlan(tenantId, await actorOf(c), id, c.req.valid("query").lang));
      } catch (e) { throw toHttpError(e); }
    });

  app.put(`${base}/:id/plan`, ...guard,
    describeRoute({ tags: ["gym"], summary: "Save the edited plan", responses: ok }),
    validator("param", tenantIdParam), isTenantMember,
    async (c) => {
      try {
        const { tenantId, id } = c.req.valid("param");
        return c.json(await updatePlan(tenantId, await actorOf(c), id, await c.req.json()));
      } catch (e) { throw toHttpError(e); }
    });

  // --- the optional reference image of a variation --------------------------
  const variationImage = `${base}/:id/plan/steps/:stepId/variations/:index/image`;

  app.get(variationImage, ...guard,
    describeRoute({ tags: ["gym"], summary: "The reference image of a variation", responses: ok }),
    validator("param", variationParam), isTenantMember,
    async (c) => {
      try {
        const { tenantId, id, stepId, index } = c.req.valid("param");
        const file = await getVariationImage(await getBlockRow(tenantId, id), stepId, index);
        if (!file) throw new HTTPException(404, { message: "No image for this variation" });
        return c.body(await file.arrayBuffer(), 200, { "Content-Type": file.type || "image/png", "Cache-Control": "private, max-age=60" });
      } catch (e) { throw toHttpError(e); }
    });

  app.post(`${variationImage}/generate`, ...guard,
    describeRoute({ tags: ["gym"], summary: "Generate the reference image of a variation from the scene photo", responses: ok }),
    validator("param", variationParam), isTenantMember,
    async (c) => {
      try {
        const { tenantId, id, stepId, index } = c.req.valid("param");
        return c.json(await generateVariationImage(tenantId, await actorOf(c), id, stepId, index));
      } catch (e) { throw toHttpError(e); }
    });

  app.post(`${variationImage}/from-scene`, ...guard,
    describeRoute({ tags: ["gym"], summary: "Use the scene photo as the reference image of a variation", responses: ok }),
    validator("param", variationParam), isTenantMember,
    async (c) => {
      try {
        const { tenantId, id, stepId, index } = c.req.valid("param");
        return c.json(await useSceneImageForVariation(tenantId, await actorOf(c), id, stepId, index));
      } catch (e) { throw toHttpError(e); }
    });

  app.post(variationImage, ...guard,
    describeRoute({ tags: ["gym"], summary: "Upload the reference image of a variation", responses: ok }),
    validator("param", variationParam), isTenantMember,
    async (c) => {
      try {
        const { tenantId, id, stepId, index } = c.req.valid("param");
        const body = await c.req.parseBody();
        const file = body["file"];
        if (!(file instanceof File)) throw new HTTPException(400, { message: "Multipart field 'file' is required" });
        return c.json(await setVariationImage(tenantId, await actorOf(c), id, stepId, index, file));
      } catch (e) { throw toHttpError(e); }
    });

  app.delete(variationImage, ...guard,
    describeRoute({ tags: ["gym"], summary: "Remove the reference image of a variation", responses: ok }),
    validator("param", variationParam), isTenantMember,
    async (c) => {
      try {
        const { tenantId, id, stepId, index } = c.req.valid("param");
        return c.json(await removeVariationImage(tenantId, await actorOf(c), id, stepId, index));
      } catch (e) { throw toHttpError(e); }
    });

  app.post(`${base}/:id/recording/start`, ...guard,
    describeRoute({ tags: ["gym"], summary: "Start recording (teleoperation or the policy run); withoutPlan runs on a plain plan", responses: ok }),
    validator("param", tenantIdParam), validator("query", v.object({ withoutPlan: v.optional(v.picklist(["true", "false"])) })), isTenantMember,
    async (c) => {
      try {
        const { tenantId, id } = c.req.valid("param");
        const withoutPlan = c.req.valid("query").withoutPlan === "true";
        return c.json(await startRecording(tenantId, await actorOf(c), id, { withoutPlan }));
      } catch (e) { throw toHttpError(e); }
    });

  app.put(`${base}/:id/recording/progress`, ...guard,
    describeRoute({ tags: ["gym"], summary: "Count an episode for a plan step", responses: ok }),
    validator("param", tenantIdParam), isTenantMember,
    async (c) => {
      try {
        const { tenantId, id } = c.req.valid("param");
        const { stepId, delta } = v.parse(progressSchema, await c.req.json());
        return c.json(await toBlockView(await recordProgress(await getBlockRow(tenantId, id), stepId, delta, await actorOf(c))));
      } catch (e) { throw toHttpError(e); }
    });

  app.put(`${base}/:id/recording/current-step`, ...guard,
    describeRoute({ tags: ["gym"], summary: "Pick the plan step to work on next", responses: ok }),
    validator("param", tenantIdParam), isTenantMember,
    async (c) => {
      try {
        const { tenantId, id } = c.req.valid("param");
        const { stepId } = v.parse(currentStepSchema, await c.req.json());
        return c.json(await toBlockView(await setCurrentStep(await getBlockRow(tenantId, id), stepId)));
      } catch (e) { throw toHttpError(e); }
    });

  app.post(`${base}/:id/recording/finish`, ...guard,
    describeRoute({ tags: ["gym"], summary: "Finish recording, go to the upload", responses: ok }),
    validator("param", tenantIdParam), isTenantMember,
    async (c) => {
      try {
        const { tenantId, id } = c.req.valid("param");
        return c.json(await finishRecording(tenantId, await actorOf(c), id));
      } catch (e) { throw toHttpError(e); }
    });

  app.post(`${base}/:id/datasets`, ...guard,
    describeRoute({ tags: ["gym"], summary: "Upload a zipped LeRobot dataset and start the critics run", responses: ok }),
    validator("param", tenantIdParam), isTenantMember,
    async (c) => {
      try {
        const { tenantId, id } = c.req.valid("param");
        const body = await c.req.parseBody();
        const file = body["file"] ?? body["files[]"] ?? body["files"];
        if (!(file instanceof File)) throw new HTTPException(400, { message: "Multipart field 'file' (a zip archive) is required" });
        const name = typeof body["name"] === "string" ? body["name"] : undefined;
        return c.json(await uploadDataset(tenantId, await actorOf(c), id, file, name), 201);
      } catch (e) { throw toHttpError(e); }
    });

  app.get(`${base}/:id/datasets/uploads`, ...guard,
    describeRoute({ tags: ["gym"], summary: "The chunked dataset uploads of this block that are still open", responses: ok }),
    validator("param", tenantIdParam), isTenantMember,
    async (c) => {
      try {
        const { tenantId, id } = c.req.valid("param");
        return c.json(await listUploads(tenantId, id));
      } catch (e) { throw toHttpError(e); }
    });

  app.post(`${base}/:id/datasets/uploads`, ...guard,
    describeRoute({ tags: ["gym"], summary: "Announce a zipped LeRobot dataset to upload in chunks", responses: ok }),
    validator("param", tenantIdParam), isTenantMember,
    async (c) => {
      try {
        const { tenantId, id } = c.req.valid("param");
        const { fileName, bytes, name } = v.parse(beginUploadSchema, await c.req.json());
        return c.json(await beginUpload(tenantId, await actorOf(c), id, { fileName, bytes, displayName: name }), 201);
      } catch (e) { throw toHttpError(e); }
    });

  app.get(`${base}/:id/datasets/uploads/:uploadId`, ...guard,
    describeRoute({ tags: ["gym"], summary: "Which chunks of an upload arrived, to resume it", responses: ok }),
    validator("param", uploadParam), isTenantMember,
    async (c) => {
      try {
        const { tenantId, id, uploadId } = c.req.valid("param");
        return c.json(await getUpload(tenantId, id, uploadId));
      } catch (e) { throw toHttpError(e); }
    });

  // the chunk is the raw body: multipart would add a copy and a parse for no gain
  app.put(`${base}/:id/datasets/uploads/:uploadId/chunks/:index`, ...guard,
    describeRoute({ tags: ["gym"], summary: "Store one chunk of a dataset upload", responses: ok }),
    validator("param", chunkParam), isTenantMember,
    async (c) => {
      try {
        const { tenantId, id, uploadId, index } = c.req.valid("param");
        return c.json(await putChunk(tenantId, id, uploadId, index, await c.req.arrayBuffer()));
      } catch (e) { throw toHttpError(e); }
    });

  app.post(`${base}/:id/datasets/uploads/:uploadId/complete`, ...guard,
    describeRoute({ tags: ["gym"], summary: "Assemble an upload and start the critics run", responses: ok }),
    validator("param", uploadParam), isTenantMember,
    async (c) => {
      try {
        const { tenantId, id, uploadId } = c.req.valid("param");
        return c.json(await completeUpload(tenantId, await actorOf(c), id, uploadId), 201);
      } catch (e) { throw toHttpError(e); }
    });

  app.delete(`${base}/:id/datasets/uploads/:uploadId`, ...guard,
    describeRoute({ tags: ["gym"], summary: "Give up an upload and drop its chunks", responses: ok }),
    validator("param", uploadParam), isTenantMember,
    async (c) => {
      try {
        const { tenantId, id, uploadId } = c.req.valid("param");
        await abortUpload(tenantId, id, uploadId);
        return c.body(null, 204);
      } catch (e) { throw toHttpError(e); }
    });

  app.post(`${base}/:id/follow-up`, ...guard,
    describeRoute({ tags: ["gym"], summary: "Let the AI suggest what to record again", responses: ok }),
    validator("param", tenantIdParam), validator("query", langQuery), isTenantMember,
    async (c) => {
      try {
        const { tenantId, id } = c.req.valid("param");
        return c.json(await suggestFollowUp(tenantId, await actorOf(c), id, c.req.valid("query").lang));
      } catch (e) { throw toHttpError(e); }
    });

  app.get(`${dsBase}/:id`, ...guard,
    describeRoute({ tags: ["gym"], summary: "One dataset with its analysis and episodes", responses: ok }),
    validator("param", tenantIdParam), isTenantMember,
    async (c) => {
      try {
        const { tenantId, id } = c.req.valid("param");
        return c.json(await getDataset(tenantId, id));
      } catch (e) { throw toHttpError(e); }
    });

  app.delete(`${dsBase}/:id`, ...guard,
    describeRoute({ tags: ["gym"], summary: "Delete a dataset and its episodes", responses: ok }),
    validator("param", tenantIdParam), isTenantMember,
    async (c) => {
      try {
        const { tenantId, id } = c.req.valid("param");
        await deleteDataset(tenantId, await actorOf(c), id);
        return c.body(null, 204);
      } catch (e) { throw toHttpError(e); }
    });
}
