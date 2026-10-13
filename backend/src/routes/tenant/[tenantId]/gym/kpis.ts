/**
 *   GET /tenant/:tenantId/gym/kpis?from&to&cellId&collectionId&skillId
 *   GET /tenant/:tenantId/gym/ai              which AI provider and image model are configured
 */
import type { SymbiosikaFrameworkHonoApp } from "@framework/types";
import { authAndSetUsersInfo, checkUserPermission } from "@framework/lib/utils/hono-middlewares";
import { isTenantMember } from "@framework/routes/tenant";
import { describeRoute, validator } from "hono-openapi";
import * as v from "valibot";
import { getGymImageModel, isImageGenerationEnabled } from "../../../../lib/ai/images";
import { getGymAiProvider } from "../../../../lib/ai/model";
import { getKpis } from "../../../../lib/gym/kpis";
import { ok, tenantParam, toHttpError } from "./_shared";

const kpiQuery = v.object({
  from: v.optional(v.string()),
  to: v.optional(v.string()),
  cellId: v.optional(v.pipe(v.string(), v.uuid())),
  collectionId: v.optional(v.pipe(v.string(), v.uuid())),
  skillId: v.optional(v.pipe(v.string(), v.uuid())),
});

export default function defineKpiRoutes(app: SymbiosikaFrameworkHonoApp, API_BASE_PATH = "") {
  app.get(`${API_BASE_PATH}/tenant/:tenantId/gym/kpis`, authAndSetUsersInfo, checkUserPermission,
    describeRoute({ tags: ["gym"], summary: "Key figures for a period, cell, collection or skill", responses: ok }),
    validator("param", tenantParam), validator("query", kpiQuery), isTenantMember,
    async (c) => {
      try {
        return c.json(await getKpis(c.req.valid("param").tenantId, c.req.valid("query")));
      } catch (e) { throw toHttpError(e); }
    });

  app.get(`${API_BASE_PATH}/tenant/:tenantId/gym/ai`, authAndSetUsersInfo, checkUserPermission,
    describeRoute({ tags: ["gym"], summary: "AI configuration of this instance", responses: ok }),
    validator("param", tenantParam), isTenantMember,
    async (c) =>
      c.json({
        provider: getGymAiProvider(),
        enabled: getGymAiProvider() !== "none",
        // images of the plan variations need Gemini; they are optional everywhere
        imageEnabled: isImageGenerationEnabled(),
        imageModel: isImageGenerationEnabled() ? getGymImageModel() : null,
      }));
}
