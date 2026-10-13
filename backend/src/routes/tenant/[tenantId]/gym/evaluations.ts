/**
 * Evaluations: the human review of a block's rollouts and the evaluation
 * reports of a skill.
 *
 *   GET    /tenant/:tenantId/gym/blocks/:id/rollouts               the rollouts of an evaluation block with critics' and human verdicts
 *   PUT    /tenant/:tenantId/gym/blocks/:id/rollouts/review        { changes: [{ episodeId, humanVerdict?, failureCode?, note?, variationLabel? }] }
 *   GET    /tenant/:tenantId/gym/skills/:id/evaluation-reports     the reports of a skill
 *   POST   /tenant/:tenantId/gym/skills/:id/evaluation-reports     { name, blockIds, sections? }
 *   GET    /tenant/:tenantId/gym/evaluation-reports/:id            the report with its figures
 *   PUT    /tenant/:tenantId/gym/evaluation-reports/:id            { name?, blockIds?, sections? }
 *   DELETE /tenant/:tenantId/gym/evaluation-reports/:id
 *
 * The public, read-only view of a report lives with the other public routes
 * (routes/public/mobile.ts): GET /public/gym/eval-report/:shareId
 */
import type { SymbiosikaFrameworkHonoApp } from "@framework/types";
import { authAndSetUsersInfo, checkUserPermission } from "@framework/lib/utils/hono-middlewares";
import { isTenantMember } from "@framework/routes/tenant";
import { describeRoute, validator } from "hono-openapi";
import { createReport, deleteReport, getReport, listReports, updateReport } from "../../../../lib/gym/evaluation-reports";
import { getRollouts, reviewRollouts } from "../../../../lib/gym/evaluations";
import { actorOf, ok, tenantIdParam, toHttpError } from "./_shared";

export default function defineEvaluationRoutes(app: SymbiosikaFrameworkHonoApp, API_BASE_PATH = "") {
  const blockBase = `${API_BASE_PATH}/tenant/:tenantId/gym/blocks`;
  const skillBase = `${API_BASE_PATH}/tenant/:tenantId/gym/skills`;
  const reportBase = `${API_BASE_PATH}/tenant/:tenantId/gym/evaluation-reports`;
  const guard = [authAndSetUsersInfo, checkUserPermission] as const;

  app.get(`${blockBase}/:id/rollouts`, ...guard,
    describeRoute({ tags: ["gym"], summary: "The rollouts of an evaluation block with the critics' and the human verdicts", responses: ok }),
    validator("param", tenantIdParam), isTenantMember,
    async (c) => {
      try {
        const { tenantId, id } = c.req.valid("param");
        return c.json(await getRollouts(tenantId, id));
      } catch (e) { throw toHttpError(e); }
    });

  app.put(`${blockBase}/:id/rollouts/review`, ...guard,
    describeRoute({ tags: ["gym"], summary: "Save the human review of rollouts: verdict, failure code, note, variation", responses: ok }),
    validator("param", tenantIdParam), isTenantMember,
    async (c) => {
      try {
        const { tenantId, id } = c.req.valid("param");
        return c.json(await reviewRollouts(tenantId, await actorOf(c), id, await c.req.json()));
      } catch (e) { throw toHttpError(e); }
    });

  app.get(`${skillBase}/:id/evaluation-reports`, ...guard,
    describeRoute({ tags: ["gym"], summary: "The evaluation reports of a skill", responses: ok }),
    validator("param", tenantIdParam), isTenantMember,
    async (c) => {
      try {
        const { tenantId, id } = c.req.valid("param");
        return c.json(await listReports(tenantId, id));
      } catch (e) { throw toHttpError(e); }
    });

  app.post(`${skillBase}/:id/evaluation-reports`, ...guard,
    describeRoute({ tags: ["gym"], summary: "Create an evaluation report over evaluation blocks of the skill", responses: ok }),
    validator("param", tenantIdParam), isTenantMember,
    async (c) => {
      try {
        const { tenantId, id } = c.req.valid("param");
        return c.json(await createReport(tenantId, await actorOf(c), id, await c.req.json()), 201);
      } catch (e) { throw toHttpError(e); }
    });

  app.get(`${reportBase}/:id`, ...guard,
    describeRoute({ tags: ["gym"], summary: "One evaluation report with its figures: success by block and variation, failure modes, every rollout", responses: ok }),
    validator("param", tenantIdParam), isTenantMember,
    async (c) => {
      try {
        const { tenantId, id } = c.req.valid("param");
        return c.json(await getReport(tenantId, id));
      } catch (e) { throw toHttpError(e); }
    });

  app.put(`${reportBase}/:id`, ...guard,
    describeRoute({ tags: ["gym"], summary: "Update an evaluation report: name, blocks, written sections", responses: ok }),
    validator("param", tenantIdParam), isTenantMember,
    async (c) => {
      try {
        const { tenantId, id } = c.req.valid("param");
        return c.json(await updateReport(tenantId, await actorOf(c), id, await c.req.json()));
      } catch (e) { throw toHttpError(e); }
    });

  app.delete(`${reportBase}/:id`, ...guard,
    describeRoute({ tags: ["gym"], summary: "Delete an evaluation report; the blocks stay", responses: ok }),
    validator("param", tenantIdParam), isTenantMember,
    async (c) => {
      try {
        const { tenantId, id } = c.req.valid("param");
        await deleteReport(tenantId, await actorOf(c), id);
        return c.body(null, 204);
      } catch (e) { throw toHttpError(e); }
    });
}
