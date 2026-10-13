/**
 *   GET    /tenant/:tenantId/gym/invitation-codes           codes of the organisation + registration status (admins)
 *   POST   /tenant/:tenantId/gym/invitation-codes           create a code { expiresAt? }
 *   PUT    /tenant/:tenantId/gym/invitation-codes/:id       { isActive }
 *   DELETE /tenant/:tenantId/gym/invitation-codes/:id
 *
 * Owners and admins only: a code opens the door to the whole instance.
 */
import type { SymbiosikaFrameworkHonoApp } from "@framework/types";
import { authAndSetUsersInfo, checkUserPermission } from "@framework/lib/utils/hono-middlewares";
import { isTenantAdmin } from "@framework/routes/tenant";
import { HTTPException } from "hono/http-exception";
import { describeRoute, validator } from "hono-openapi";
import * as v from "valibot";
import {
  createInvitationCode,
  deleteInvitationCode,
  listInvitationCodes,
  registrationStatus,
  setInvitationCodeActive,
} from "../../../../lib/gym/invitation-codes";
import { ok, tenantIdParam, tenantParam, toHttpError } from "./_shared";

const createBody = v.object({
  expiresAt: v.optional(v.nullable(v.pipe(v.string(), v.isoTimestamp()))),
});
const updateBody = v.object({ isActive: v.boolean() });

export default function defineInvitationCodeRoutes(app: SymbiosikaFrameworkHonoApp, API_BASE_PATH = "") {
  const base = `${API_BASE_PATH}/tenant/:tenantId/gym/invitation-codes`;

  app.get(base, authAndSetUsersInfo, checkUserPermission,
    describeRoute({ tags: ["gym"], summary: "Invitation codes and registration status", responses: ok }),
    validator("param", tenantParam), isTenantAdmin,
    async (c) => {
      const { tenantId } = c.req.valid("param");
      try {
        return c.json({ status: await registrationStatus(tenantId), codes: await listInvitationCodes(tenantId) });
      } catch (e) { throw toHttpError(e); }
    });

  app.post(base, authAndSetUsersInfo, checkUserPermission,
    describeRoute({ tags: ["gym"], summary: "Create an invitation code", responses: ok }),
    validator("param", tenantParam), validator("json", createBody), isTenantAdmin,
    async (c) => {
      const { tenantId } = c.req.valid("param");
      const { expiresAt } = c.req.valid("json");
      if (expiresAt && new Date(expiresAt).getTime() <= Date.now())
        throw new HTTPException(400, { message: "expiresAt must be in the future" });
      try { return c.json(await createInvitationCode(tenantId, { expiresAt: expiresAt ?? null })); }
      catch (e) { throw toHttpError(e); }
    });

  app.put(`${base}/:id`, authAndSetUsersInfo, checkUserPermission,
    describeRoute({ tags: ["gym"], summary: "Activate or deactivate a code", responses: ok }),
    validator("param", tenantIdParam), validator("json", updateBody), isTenantAdmin,
    async (c) => {
      const { tenantId, id } = c.req.valid("param");
      const row = await setInvitationCodeActive(tenantId, id, c.req.valid("json").isActive);
      if (!row) throw new HTTPException(404, { message: "Invitation code not found" });
      return c.json(row);
    });

  app.delete(`${base}/:id`, authAndSetUsersInfo, checkUserPermission,
    describeRoute({ tags: ["gym"], summary: "Delete a code", responses: ok }),
    validator("param", tenantIdParam), isTenantAdmin,
    async (c) => {
      const { tenantId, id } = c.req.valid("param");
      if (!(await deleteInvitationCode(tenantId, id))) throw new HTTPException(404, { message: "Invitation code not found" });
      return c.json({ success: true });
    });
}
