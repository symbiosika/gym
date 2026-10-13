/**
 * Unauthenticated routes for the phone at the cell and for the shared print
 * view. Nobody is signed in on these devices; access is granted by
 *
 *   - the block's access token (mobile views, expires, revoked when the block closes)
 *   - the day's share id (printable view, read-only)
 *   - the evaluation report's share id (read-only report view)
 *
 *   GET  /public/gym/m/:token                state for the mobile views
 *   POST /public/gym/m/:token/scene-image    multipart "file": the scene photo
 *   PUT  /public/gym/m/:token/scene-text     { text }
 *   POST /public/gym/m/:token/scene-done     the operator pressed "done"
 *   GET  /public/gym/m/:token/scene-image    the current photo
 *   PUT  /public/gym/m/:token/progress       { stepId, delta } from the recording run view
 *   PUT  /public/gym/m/:token/current-step   { stepId } the step to work on next
 *   GET  /public/gym/m/:token/plan-image/:stepId/:index   reference image of a plan variation
 *   GET  /public/gym/print/:shareId          printable day protocol with its blocks
 *   GET  /public/gym/print/:shareId/blocks/:blockId/scene-image
 *   GET  /public/gym/eval-report/:shareId    an evaluation report, read-only, with its figures
 */
import type { SymbiosikaFrameworkHonoApp } from "@framework/types";
import { HTTPException } from "hono/http-exception";
import { describeRoute, validator } from "hono-openapi";
import * as v from "valibot";
import {
  currentStepSchema,
  getSceneImage,
  getVariationImage,
  markSceneCaptured,
  mobileState,
  progressSchema,
  recordProgress,
  resolveAccessToken,
  setCurrentStep,
  setSceneImage,
  setSceneText,
} from "../../lib/gym/blocks";
import { blockOfDay, getDayByShareId, printView } from "../../lib/gym/day-protocols";
import { getReportByShareId } from "../../lib/gym/evaluation-reports";
import { ok, toHttpError } from "../tenant/[tenantId]/gym/_shared";

const tokenParam = v.object({ token: v.pipe(v.string(), v.minLength(16), v.maxLength(64)) });
const shareParam = v.object({ shareId: v.pipe(v.string(), v.minLength(8), v.maxLength(32)) });
const shareBlockParam = v.object({ shareId: v.pipe(v.string(), v.minLength(8), v.maxLength(32)), blockId: v.pipe(v.string(), v.uuid()) });
const variationParam = v.object({
  token: v.pipe(v.string(), v.minLength(16), v.maxLength(64)),
  stepId: v.pipe(v.string(), v.minLength(1), v.maxLength(100)),
  index: v.pipe(v.string(), v.transform(Number), v.number(), v.integer(), v.minValue(0), v.maxValue(1000)),
});

const imageResponse = async (file: File | null) => {
  if (!file) throw new HTTPException(404, { message: "No image" });
  return new Response(await file.arrayBuffer(), { status: 200, headers: { "Content-Type": file.type || "image/jpeg", "Cache-Control": "no-store" } });
};

export default function defineMobileRoutes(app: SymbiosikaFrameworkHonoApp, API_BASE_PATH = "") {
  const m = `${API_BASE_PATH}/public/gym/m/:token`;
  const p = `${API_BASE_PATH}/public/gym/print/:shareId`;

  app.get(m, describeRoute({ tags: ["gym-public"], summary: "State of the block for the phone", responses: ok }), validator("param", tokenParam), async (c) => {
    try {
      return c.json(await mobileState(await resolveAccessToken(c.req.valid("param").token)), 200, { "Cache-Control": "no-store" });
    } catch (e) { throw toHttpError(e); }
  });

  app.post(`${m}/scene-image`, describeRoute({ tags: ["gym-public"], summary: "Upload the scene photo", responses: ok }), validator("param", tokenParam), async (c) => {
    try {
      const block = await resolveAccessToken(c.req.valid("param").token);
      const body = await c.req.parseBody();
      const file = body["file"];
      if (!(file instanceof File)) throw new HTTPException(400, { message: "Multipart field 'file' is required" });
      return c.json(await mobileState(await setSceneImage(block, file)));
    } catch (e) { throw toHttpError(e); }
  });

  app.get(`${m}/scene-image`, describeRoute({ tags: ["gym-public"], summary: "The scene photo", responses: ok }), validator("param", tokenParam), async (c) => {
    try {
      return imageResponse(await getSceneImage(await resolveAccessToken(c.req.valid("param").token)));
    } catch (e) { throw toHttpError(e); }
  });

  app.put(`${m}/scene-text`, describeRoute({ tags: ["gym-public"], summary: "Save the scene description", responses: ok }), validator("param", tokenParam), async (c) => {
    try {
      const block = await resolveAccessToken(c.req.valid("param").token);
      const { text } = v.parse(v.object({ text: v.pipe(v.string(), v.maxLength(8000)) }), await c.req.json());
      return c.json(await mobileState(await setSceneText(block, text)));
    } catch (e) { throw toHttpError(e); }
  });

  app.post(`${m}/scene-done`, describeRoute({ tags: ["gym-public"], summary: "The phone is done with the brief", responses: ok }), validator("param", tokenParam), async (c) => {
    try {
      return c.json(await mobileState(await markSceneCaptured(await resolveAccessToken(c.req.valid("param").token))));
    } catch (e) { throw toHttpError(e); }
  });

  app.put(`${m}/progress`, describeRoute({ tags: ["gym-public"], summary: "Count an episode from the recording run view", responses: ok }), validator("param", tokenParam), async (c) => {
    try {
      const block = await resolveAccessToken(c.req.valid("param").token);
      const { stepId, delta } = v.parse(progressSchema, await c.req.json());
      return c.json(await mobileState(await recordProgress(block, stepId, delta)));
    } catch (e) { throw toHttpError(e); }
  });

  app.put(`${m}/current-step`, describeRoute({ tags: ["gym-public"], summary: "Pick the plan step to work on next", responses: ok }), validator("param", tokenParam), async (c) => {
    try {
      const block = await resolveAccessToken(c.req.valid("param").token);
      const { stepId } = v.parse(currentStepSchema, await c.req.json());
      return c.json(await mobileState(await setCurrentStep(block, stepId)));
    } catch (e) { throw toHttpError(e); }
  });

  app.get(`${m}/plan-image/:stepId/:index`, describeRoute({ tags: ["gym-public"], summary: "Reference image of a plan variation", responses: ok }), validator("param", variationParam), async (c) => {
    try {
      const { token, stepId, index } = c.req.valid("param");
      return imageResponse(await getVariationImage(await resolveAccessToken(token), stepId, index));
    } catch (e) { throw toHttpError(e); }
  });

  app.get(p, describeRoute({ tags: ["gym-public"], summary: "Printable day protocol", responses: ok }), validator("param", shareParam), async (c) => {
    try {
      return c.json(await printView(await getDayByShareId(c.req.valid("param").shareId)), 200, { "Cache-Control": "no-store" });
    } catch (e) { throw toHttpError(e); }
  });

  app.get(`${API_BASE_PATH}/public/gym/eval-report/:shareId`, describeRoute({ tags: ["gym-public"], summary: "Read-only evaluation report", responses: ok }), validator("param", shareParam), async (c) => {
    try {
      return c.json(await getReportByShareId(c.req.valid("param").shareId), 200, { "Cache-Control": "no-store" });
    } catch (e) { throw toHttpError(e); }
  });

  app.get(`${p}/blocks/:blockId/scene-image`, describeRoute({ tags: ["gym-public"], summary: "Scene photo of a block in the printable view", responses: ok }), validator("param", shareBlockParam), async (c) => {
    try {
      const { shareId, blockId } = c.req.valid("param");
      return imageResponse(await getSceneImage(await blockOfDay(await getDayByShareId(shareId), blockId)));
    } catch (e) { throw toHttpError(e); }
  });
}
