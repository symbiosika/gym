/**
 * Robots: the robots of the gym, their capabilities and their photo. Which
 * cell a robot is in is set on the cell (master-data.ts).
 *
 *   GET/POST          /tenant/:tenantId/gym/robots
 *   GET/PUT/DELETE    /tenant/:tenantId/gym/robots/:id
 *   GET               /tenant/:tenantId/gym/robots/:id/audit       the robot's history
 *   GET               /tenant/:tenantId/gym/robots/:id/image
 *   POST              /tenant/:tenantId/gym/robots/:id/image       multipart "file"
 *   DELETE            /tenant/:tenantId/gym/robots/:id/image
 *
 * Every member may read; writing is for owners and admins, as for cells.
 */
import type { SymbiosikaFrameworkHonoApp } from "@framework/types";
import { authAndSetUsersInfo, checkUserPermission } from "@framework/lib/utils/hono-middlewares";
import { isTenantAdmin, isTenantMember } from "@framework/routes/tenant";
import { HTTPException } from "hono/http-exception";
import { describeRoute, validator } from "hono-openapi";
import {
  createRobot,
  deleteRobot,
  getRobot,
  getRobotImage,
  listRobotAudit,
  listRobots,
  removeRobotImage,
  setRobotImage,
  updateRobot,
} from "../../../../lib/gym/robots";
import { actorOf, ok, tenantIdParam, tenantParam, toHttpError } from "./_shared";

export default function defineRobotRoutes(app: SymbiosikaFrameworkHonoApp, API_BASE_PATH = "") {
  const base = `${API_BASE_PATH}/tenant/:tenantId/gym/robots`;
  const guard = [authAndSetUsersInfo, checkUserPermission] as const;

  app.get(base, ...guard,
    describeRoute({ tags: ["gym"], summary: "List robots with the cell each is in", responses: ok }),
    validator("param", tenantParam), isTenantMember,
    async (c) => {
      try {
        return c.json(await listRobots(c.req.valid("param").tenantId));
      } catch (e) { throw toHttpError(e); }
    });

  app.post(base, ...guard,
    describeRoute({ tags: ["gym"], summary: "Create a robot", responses: ok }),
    validator("param", tenantParam), isTenantAdmin,
    async (c) => {
      try {
        const { tenantId } = c.req.valid("param");
        return c.json(await createRobot(tenantId, await actorOf(c), await c.req.json()), 201);
      } catch (e) { throw toHttpError(e); }
    });

  app.get(`${base}/:id`, ...guard,
    describeRoute({ tags: ["gym"], summary: "A robot with its capabilities and cell", responses: ok }),
    validator("param", tenantIdParam), isTenantMember,
    async (c) => {
      try {
        const { tenantId, id } = c.req.valid("param");
        return c.json(await getRobot(tenantId, id));
      } catch (e) { throw toHttpError(e); }
    });

  app.put(`${base}/:id`, ...guard,
    describeRoute({ tags: ["gym"], summary: "Update a robot; a section sent replaces that section", responses: ok }),
    validator("param", tenantIdParam), isTenantAdmin,
    async (c) => {
      try {
        const { tenantId, id } = c.req.valid("param");
        return c.json(await updateRobot(tenantId, await actorOf(c), id, await c.req.json()));
      } catch (e) { throw toHttpError(e); }
    });

  app.delete(`${base}/:id`, ...guard,
    describeRoute({ tags: ["gym"], summary: "Delete a robot; its cell keeps an undefined robot", responses: ok }),
    validator("param", tenantIdParam), isTenantAdmin,
    async (c) => {
      try {
        const { tenantId, id } = c.req.valid("param");
        await deleteRobot(tenantId, await actorOf(c), id);
        return c.body(null, 204);
      } catch (e) { throw toHttpError(e); }
    });

  app.get(`${base}/:id/audit`, ...guard,
    describeRoute({ tags: ["gym"], summary: "The robot's history, newest first", responses: ok }),
    validator("param", tenantIdParam), isTenantMember,
    async (c) => {
      try {
        const { tenantId, id } = c.req.valid("param");
        return c.json(await listRobotAudit(tenantId, id));
      } catch (e) { throw toHttpError(e); }
    });

  app.get(`${base}/:id/image`, ...guard,
    describeRoute({ tags: ["gym"], summary: "The robot's photo", responses: ok }),
    validator("param", tenantIdParam), isTenantMember,
    async (c) => {
      try {
        const { tenantId, id } = c.req.valid("param");
        const file = await getRobotImage(tenantId, id);
        if (!file) throw new HTTPException(404, { message: "No robot image" });
        return c.body(await file.arrayBuffer(), 200, { "Content-Type": file.type || "image/jpeg", "Cache-Control": "private, max-age=60" });
      } catch (e) { throw toHttpError(e); }
    });

  app.post(`${base}/:id/image`, ...guard,
    describeRoute({ tags: ["gym"], summary: "Replace the robot's photo", responses: ok }),
    validator("param", tenantIdParam), isTenantAdmin,
    async (c) => {
      try {
        const { tenantId, id } = c.req.valid("param");
        const body = await c.req.parseBody();
        const file = body["file"];
        if (!(file instanceof File)) throw new HTTPException(400, { message: "Multipart field 'file' is required" });
        return c.json(await setRobotImage(tenantId, await actorOf(c), id, file));
      } catch (e) { throw toHttpError(e); }
    });

  app.delete(`${base}/:id/image`, ...guard,
    describeRoute({ tags: ["gym"], summary: "Remove the robot's photo", responses: ok }),
    validator("param", tenantIdParam), isTenantAdmin,
    async (c) => {
      try {
        const { tenantId, id } = c.req.valid("param");
        return c.json(await removeRobotImage(tenantId, await actorOf(c), id));
      } catch (e) { throw toHttpError(e); }
    });
}
