/**
 * The guided tour.
 *
 *   GET /tenant/:tenantId/gym/tour     what the tour shows of the tour skill (every member)
 *   PUT /tenant/:tenantId/gym/tour     { skillId | null }: choose the tour skill (owners and admins)
 */
import type { SymbiosikaFrameworkHonoApp } from "@framework/types";
import { authAndSetUsersInfo, checkUserPermission } from "@framework/lib/utils/hono-middlewares";
import { isTenantAdmin, isTenantMember } from "@framework/routes/tenant";
import { describeRoute, validator } from "hono-openapi";
import { setTourSkill, tourMaterial } from "../../../../lib/gym/tour";
import { actorOf, ok, tenantParam, toHttpError } from "./_shared";

export default function defineTourRoutes(app: SymbiosikaFrameworkHonoApp, API_BASE_PATH = "") {
  const base = `${API_BASE_PATH}/tenant/:tenantId/gym/tour`;

  app.get(base, authAndSetUsersInfo, checkUserPermission,
    describeRoute({ tags: ["gym"], summary: "What the guided tour shows of the tour skill", responses: ok }),
    validator("param", tenantParam), isTenantMember,
    async (c) => {
      try {
        return c.json(await tourMaterial(c.req.valid("param").tenantId));
      } catch (e) { throw toHttpError(e); }
    });

  app.put(base, authAndSetUsersInfo, checkUserPermission,
    describeRoute({ tags: ["gym"], summary: "Choose the skill the guided tour walks through", responses: ok }),
    validator("param", tenantParam), isTenantAdmin,
    async (c) => {
      try {
        const { tenantId } = c.req.valid("param");
        return c.json(await setTourSkill(tenantId, await actorOf(c), await c.req.json().catch(() => ({}))));
      } catch (e) { throw toHttpError(e); }
    });
}
