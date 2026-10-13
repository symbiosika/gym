/**
 * Cells and collections: the two pick lists of an organisation.
 *
 *   GET/POST          /tenant/:tenantId/gym/cells
 *   PUT/DELETE        /tenant/:tenantId/gym/cells/:id
 *   GET/POST          /tenant/:tenantId/gym/collections
 *   PUT/DELETE        /tenant/:tenantId/gym/collections/:id
 *
 * Every member may read; writing is for owners and admins.
 */
import type { SymbiosikaFrameworkHonoApp } from "@framework/types";
import { authAndSetUsersInfo, checkUserPermission } from "@framework/lib/utils/hono-middlewares";
import { isTenantAdmin, isTenantMember } from "@framework/routes/tenant";
import { describeRoute, validator } from "hono-openapi";
import * as v from "valibot";
import { createCell, deleteCell, listCells, updateCell } from "../../../../lib/gym/cells";
import { createCollection, deleteCollection, listCollections, updateCollection } from "../../../../lib/gym/collections";
import { ok, tenantIdParam, tenantParam, toHttpError } from "./_shared";

export default function defineMasterDataRoutes(app: SymbiosikaFrameworkHonoApp, API_BASE_PATH = "") {
  const cellsBase = `${API_BASE_PATH}/tenant/:tenantId/gym/cells`;
  const collectionsBase = `${API_BASE_PATH}/tenant/:tenantId/gym/collections`;

  app.get(cellsBase, authAndSetUsersInfo, checkUserPermission,
    describeRoute({ tags: ["gym"], summary: "List cells", responses: ok }),
    validator("param", tenantParam), validator("query", v.object({ all: v.optional(v.string()) })), isTenantMember,
    async (c) => {
      try {
        const { tenantId } = c.req.valid("param");
        return c.json(await listCells(tenantId, c.req.valid("query").all !== "false"));
      } catch (e) { throw toHttpError(e); }
    });

  app.post(cellsBase, authAndSetUsersInfo, checkUserPermission,
    describeRoute({ tags: ["gym"], summary: "Create a cell", responses: ok }),
    validator("param", tenantParam), isTenantAdmin,
    async (c) => {
      try {
        const { tenantId } = c.req.valid("param");
        return c.json(await createCell(tenantId, await c.req.json()), 201);
      } catch (e) { throw toHttpError(e); }
    });

  app.put(`${cellsBase}/:id`, authAndSetUsersInfo, checkUserPermission,
    describeRoute({ tags: ["gym"], summary: "Update a cell", responses: ok }),
    validator("param", tenantIdParam), isTenantAdmin,
    async (c) => {
      try {
        const { tenantId, id } = c.req.valid("param");
        return c.json(await updateCell(tenantId, id, await c.req.json()));
      } catch (e) { throw toHttpError(e); }
    });

  app.delete(`${cellsBase}/:id`, authAndSetUsersInfo, checkUserPermission,
    describeRoute({ tags: ["gym"], summary: "Delete a cell", responses: ok }),
    validator("param", tenantIdParam), isTenantAdmin,
    async (c) => {
      try {
        const { tenantId, id } = c.req.valid("param");
        await deleteCell(tenantId, id);
        return c.body(null, 204);
      } catch (e) { throw toHttpError(e); }
    });

  app.get(collectionsBase, authAndSetUsersInfo, checkUserPermission,
    describeRoute({ tags: ["gym"], summary: "List collections", responses: ok }),
    validator("param", tenantParam), isTenantMember,
    async (c) => {
      try {
        return c.json(await listCollections(c.req.valid("param").tenantId));
      } catch (e) { throw toHttpError(e); }
    });

  app.post(collectionsBase, authAndSetUsersInfo, checkUserPermission,
    describeRoute({ tags: ["gym"], summary: "Create a collection", responses: ok }),
    validator("param", tenantParam), isTenantMember,
    async (c) => {
      try {
        const { tenantId } = c.req.valid("param");
        return c.json(await createCollection(tenantId, c.get("usersId"), await c.req.json()), 201);
      } catch (e) { throw toHttpError(e); }
    });

  app.put(`${collectionsBase}/:id`, authAndSetUsersInfo, checkUserPermission,
    describeRoute({ tags: ["gym"], summary: "Update a collection", responses: ok }),
    validator("param", tenantIdParam), isTenantMember,
    async (c) => {
      try {
        const { tenantId, id } = c.req.valid("param");
        return c.json(await updateCollection(tenantId, id, await c.req.json()));
      } catch (e) { throw toHttpError(e); }
    });

  app.delete(`${collectionsBase}/:id`, authAndSetUsersInfo, checkUserPermission,
    describeRoute({ tags: ["gym"], summary: "Delete a collection", responses: ok }),
    validator("param", tenantIdParam), isTenantAdmin,
    async (c) => {
      try {
        const { tenantId, id } = c.req.valid("param");
        await deleteCollection(tenantId, id);
        return c.body(null, 204);
      } catch (e) { throw toHttpError(e); }
    });
}
