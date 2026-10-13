/**
 * Day protocols: the controlling record of a cell and day, with its blocks.
 *
 *   GET    /tenant/:tenantId/gym/days?from&to&cellId&skillId&limit
 *   GET    /tenant/:tenantId/gym/days/:id
 *   PUT    /tenant/:tenantId/gym/days/:id                    { notes?, operatorName? }
 *   POST   /tenant/:tenantId/gym/days/:id/close              closes the open blocks with it
 *   DELETE /tenant/:tenantId/gym/days/:id                    with its blocks and datasets
 *   GET    /tenant/:tenantId/gym/days/:id/audit
 *   POST   /tenant/:tenantId/gym/days/:id/downtime           { reason, minutes, at? } a downtime by hand
 *   DELETE /tenant/:tenantId/gym/days/:id/downtime/:eventId
 */
import type { SymbiosikaFrameworkHonoApp } from "@framework/types";
import { authAndSetUsersInfo, checkUserPermission } from "@framework/lib/utils/hono-middlewares";
import { isTenantMember } from "@framework/routes/tenant";
import { describeRoute, validator } from "hono-openapi";
import * as v from "valibot";
import { listAudit } from "../../../../lib/gym/audit";
import { addDowntime, closeDay, deleteDay, getDay, listDays, removeDowntime, updateDay } from "../../../../lib/gym/day-protocols";
import { actorOf, ok, tenantIdParam, tenantParam, toHttpError } from "./_shared";

/** the day plus one of its downtime entries */
const downtimeParam = v.object({
  tenantId: v.pipe(v.string(), v.uuid()),
  id: v.pipe(v.string(), v.uuid()),
  eventId: v.pipe(v.string(), v.uuid()),
});

const listQuery = v.object({
  from: v.optional(v.string()),
  to: v.optional(v.string()),
  cellId: v.optional(v.pipe(v.string(), v.uuid())),
  skillId: v.optional(v.pipe(v.string(), v.uuid())),
  limit: v.optional(v.pipe(v.string(), v.transform(Number), v.number(), v.integer(), v.minValue(1), v.maxValue(5000))),
});

export default function defineDayProtocolRoutes(app: SymbiosikaFrameworkHonoApp, API_BASE_PATH = "") {
  const base = `${API_BASE_PATH}/tenant/:tenantId/gym/days`;
  const guard = [authAndSetUsersInfo, checkUserPermission] as const;

  app.get(base, ...guard,
    describeRoute({ tags: ["gym"], summary: "List day protocols", responses: ok }),
    validator("param", tenantParam), validator("query", listQuery), isTenantMember,
    async (c) => {
      try {
        return c.json(await listDays(c.req.valid("param").tenantId, c.req.valid("query")));
      } catch (e) { throw toHttpError(e); }
    });

  app.get(`${base}/:id`, ...guard,
    describeRoute({ tags: ["gym"], summary: "One day protocol with its blocks", responses: ok }),
    validator("param", tenantIdParam), isTenantMember,
    async (c) => {
      try {
        const { tenantId, id } = c.req.valid("param");
        return c.json(await getDay(tenantId, id));
      } catch (e) { throw toHttpError(e); }
    });

  app.put(`${base}/:id`, ...guard,
    describeRoute({ tags: ["gym"], summary: "Update notes and operator of a day", responses: ok }),
    validator("param", tenantIdParam), isTenantMember,
    async (c) => {
      try {
        const { tenantId, id } = c.req.valid("param");
        return c.json(await updateDay(tenantId, await actorOf(c), id, await c.req.json()));
      } catch (e) { throw toHttpError(e); }
    });

  app.post(`${base}/:id/close`, ...guard,
    describeRoute({ tags: ["gym"], summary: "Close the day and its open blocks", responses: ok }),
    validator("param", tenantIdParam), isTenantMember,
    async (c) => {
      try {
        const { tenantId, id } = c.req.valid("param");
        return c.json(await closeDay(tenantId, await actorOf(c), id));
      } catch (e) { throw toHttpError(e); }
    });

  app.delete(`${base}/:id`, ...guard,
    describeRoute({ tags: ["gym"], summary: "Delete a day protocol with its blocks and datasets", responses: ok }),
    validator("param", tenantIdParam), isTenantMember,
    async (c) => {
      try {
        const { tenantId, id } = c.req.valid("param");
        await deleteDay(tenantId, await actorOf(c), id);
        return c.body(null, 204);
      } catch (e) { throw toHttpError(e); }
    });

  app.get(`${base}/:id/audit`, ...guard,
    describeRoute({ tags: ["gym"], summary: "Audit log of a day protocol", responses: ok }),
    validator("param", tenantIdParam), isTenantMember,
    async (c) => {
      try {
        const { tenantId, id } = c.req.valid("param");
        return c.json(await listAudit(tenantId, { dayProtocolId: id }));
      } catch (e) { throw toHttpError(e); }
    });

  app.post(`${base}/:id/downtime`, ...guard,
    describeRoute({ tags: ["gym"], summary: "Write down a downtime of the cell", responses: ok }),
    validator("param", tenantIdParam), isTenantMember,
    async (c) => {
      try {
        const { tenantId, id } = c.req.valid("param");
        return c.json(await addDowntime(tenantId, await actorOf(c), id, await c.req.json()), 201);
      } catch (e) { throw toHttpError(e); }
    });

  app.delete(`${base}/:id/downtime/:eventId`, ...guard,
    describeRoute({ tags: ["gym"], summary: "Remove a downtime", responses: ok }),
    validator("param", downtimeParam), isTenantMember,
    async (c) => {
      try {
        const { tenantId, id, eventId } = c.req.valid("param");
        return c.json(await removeDowntime(tenantId, await actorOf(c), id, eventId));
      } catch (e) { throw toHttpError(e); }
    });
}
