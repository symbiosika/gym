/**
 * Skills, their policies, their episode selection and exports.
 *
 *   GET    /tenant/:tenantId/gym/skills?status&collectionId&limit
 *   POST   /tenant/:tenantId/gym/skills                    { name, collectionId?, taskDescription?, criticSpecName? }
 *   GET    /tenant/:tenantId/gym/skills/:id                skill with blocks, exports, policies, evaluations
 *   PUT    /tenant/:tenantId/gym/skills/:id                also { status: "archived" }
 *   DELETE /tenant/:tenantId/gym/skills/:id
 *   GET    /tenant/:tenantId/gym/skills/:id/audit
 *   GET    /tenant/:tenantId/gym/skills/:id/selection      every episode of the skill's recording datasets
 *   PUT    /tenant/:tenantId/gym/skills/:id/selection      { changes: [{ episodeId, selected }] }
 *   GET    /tenant/:tenantId/gym/skills/:id/exports
 *   POST   /tenant/:tenantId/gym/skills/:id/exports        { name? } → zip download
 *   POST   /tenant/:tenantId/gym/skills/:id/exports/dataset  { name? } → the selection as one merged LeRobot dataset
 *   GET    /tenant/:tenantId/gym/exports/:id/download
 *   GET    /tenant/:tenantId/gym/skills/:id/policies
 *   POST   /tenant/:tenantId/gym/skills/:id/policies       { name, exportId?, notes?, trainedAt? }
 *   PUT    /tenant/:tenantId/gym/policies/:id
 *   DELETE /tenant/:tenantId/gym/policies/:id
 */
import type { SymbiosikaFrameworkHonoApp } from "@framework/types";
import { authAndSetUsersInfo, checkUserPermission } from "@framework/lib/utils/hono-middlewares";
import { isTenantMember } from "@framework/routes/tenant";
import { describeRoute, validator } from "hono-openapi";
import * as v from "valibot";
import { SKILL_STATUSES } from "../../../../db/schema";
import { listAudit } from "../../../../lib/gym/audit";
import { createExport, createMergedExport, getExportZip, getSelection, listExports, updateSelection } from "../../../../lib/gym/exports";
import { createPolicy, createSkill, deletePolicy, deleteSkill, getSkill, listPolicies, listSkills, updatePolicy, updateSkill } from "../../../../lib/gym/skills";
import { actorOf, ok, tenantIdParam, tenantParam, toHttpError } from "./_shared";

const listQuery = v.object({
  status: v.optional(v.picklist(SKILL_STATUSES)),
  collectionId: v.optional(v.pipe(v.string(), v.uuid())),
  limit: v.optional(v.pipe(v.string(), v.transform(Number), v.number(), v.integer(), v.minValue(1), v.maxValue(5000))),
});

const zipResponse = (c: { body: (b: Uint8Array | ArrayBuffer, status: 200, headers: Record<string, string>) => Response }, zip: Uint8Array, fileName: string) =>
  c.body(zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength) as ArrayBuffer, 200, {
    "Content-Type": "application/zip",
    "Content-Disposition": `attachment; filename="${fileName}"`,
  });

export default function defineSkillRoutes(app: SymbiosikaFrameworkHonoApp, API_BASE_PATH = "") {
  const base = `${API_BASE_PATH}/tenant/:tenantId/gym/skills`;
  const guard = [authAndSetUsersInfo, checkUserPermission] as const;

  app.get(base, ...guard,
    describeRoute({ tags: ["gym"], summary: "List skills", responses: ok }),
    validator("param", tenantParam), validator("query", listQuery), isTenantMember,
    async (c) => {
      try {
        return c.json(await listSkills(c.req.valid("param").tenantId, c.req.valid("query")));
      } catch (e) { throw toHttpError(e); }
    });

  app.post(base, ...guard,
    describeRoute({ tags: ["gym"], summary: "Create a skill", responses: ok }),
    validator("param", tenantParam), isTenantMember,
    async (c) => {
      try {
        const { tenantId } = c.req.valid("param");
        return c.json(await createSkill(tenantId, await actorOf(c), await c.req.json()), 201);
      } catch (e) { throw toHttpError(e); }
    });

  app.get(`${base}/:id`, ...guard,
    describeRoute({ tags: ["gym"], summary: "One skill with blocks, exports, policies and evaluations", responses: ok }),
    validator("param", tenantIdParam), isTenantMember,
    async (c) => {
      try {
        const { tenantId, id } = c.req.valid("param");
        return c.json(await getSkill(tenantId, id));
      } catch (e) { throw toHttpError(e); }
    });

  app.put(`${base}/:id`, ...guard,
    describeRoute({ tags: ["gym"], summary: "Update a skill", responses: ok }),
    validator("param", tenantIdParam), isTenantMember,
    async (c) => {
      try {
        const { tenantId, id } = c.req.valid("param");
        return c.json(await updateSkill(tenantId, await actorOf(c), id, await c.req.json()));
      } catch (e) { throw toHttpError(e); }
    });

  app.delete(`${base}/:id`, ...guard,
    describeRoute({ tags: ["gym"], summary: "Delete a skill with its blocks, datasets, exports and policies", responses: ok }),
    validator("param", tenantIdParam), isTenantMember,
    async (c) => {
      try {
        const { tenantId, id } = c.req.valid("param");
        await deleteSkill(tenantId, id);
        return c.body(null, 204);
      } catch (e) { throw toHttpError(e); }
    });

  app.get(`${base}/:id/audit`, ...guard,
    describeRoute({ tags: ["gym"], summary: "Audit log of a skill", responses: ok }),
    validator("param", tenantIdParam), isTenantMember,
    async (c) => {
      try {
        const { tenantId, id } = c.req.valid("param");
        return c.json(await listAudit(tenantId, { skillId: id }));
      } catch (e) { throw toHttpError(e); }
    });

  app.get(`${base}/:id/selection`, ...guard,
    describeRoute({ tags: ["gym"], summary: "Every episode of the skill's recording datasets with its selection", responses: ok }),
    validator("param", tenantIdParam), isTenantMember,
    async (c) => {
      try {
        const { tenantId, id } = c.req.valid("param");
        return c.json(await getSelection(tenantId, id));
      } catch (e) { throw toHttpError(e); }
    });

  app.put(`${base}/:id/selection`, ...guard,
    describeRoute({ tags: ["gym"], summary: "Save selection changes", responses: ok }),
    validator("param", tenantIdParam), isTenantMember,
    async (c) => {
      try {
        const { tenantId, id } = c.req.valid("param");
        return c.json(await updateSelection(tenantId, await actorOf(c), id, await c.req.json()));
      } catch (e) { throw toHttpError(e); }
    });

  app.get(`${base}/:id/exports`, ...guard,
    describeRoute({ tags: ["gym"], summary: "Exports of a skill", responses: ok }),
    validator("param", tenantIdParam), isTenantMember,
    async (c) => {
      try {
        const { tenantId, id } = c.req.valid("param");
        return c.json(await listExports(tenantId, id));
      } catch (e) { throw toHttpError(e); }
    });

  app.post(`${base}/:id/exports`, ...guard,
    describeRoute({ tags: ["gym"], summary: "Save the selection and download the manifest", responses: ok }),
    validator("param", tenantIdParam), isTenantMember,
    async (c) => {
      try {
        const { tenantId, id } = c.req.valid("param");
        const body = ((await c.req.json().catch(() => ({}))) ?? {}) as { name?: string };
        const result = await createExport(tenantId, await actorOf(c), id, body.name);
        c.header("X-Export-Id", result.record.id);
        return zipResponse(c, result.zip, result.fileName);
      } catch (e) { throw toHttpError(e); }
    });

  app.post(`${base}/:id/exports/dataset`, ...guard,
    describeRoute({ tags: ["gym"], summary: "Save the selection and download it as one merged LeRobot dataset", responses: ok }),
    validator("param", tenantIdParam), isTenantMember,
    async (c) => {
      try {
        const { tenantId, id } = c.req.valid("param");
        const body = ((await c.req.json().catch(() => ({}))) ?? {}) as { name?: string };
        const result = await createMergedExport(tenantId, await actorOf(c), id, body.name);
        // streamed through: a merged dataset with videos is far too big to hold in memory
        return new Response(result.body, {
          status: 200,
          headers: {
            "Content-Type": "application/zip",
            "Content-Disposition": `attachment; filename="${result.fileName}"`,
            "X-Export-Id": result.record.id,
            "X-Export-Episodes": String(result.episodes),
          },
        });
      } catch (e) { throw toHttpError(e); }
    });

  app.get(`${API_BASE_PATH}/tenant/:tenantId/gym/exports/:id/download`, ...guard,
    describeRoute({ tags: ["gym"], summary: "Download an earlier export", responses: ok }),
    validator("param", tenantIdParam), isTenantMember,
    async (c) => {
      try {
        const { tenantId, id } = c.req.valid("param");
        const result = await getExportZip(tenantId, id);
        return zipResponse(c, result.zip, result.fileName);
      } catch (e) { throw toHttpError(e); }
    });

  // --- policies: the trained versions of a skill --------------------------------
  app.get(`${base}/:id/policies`, ...guard,
    describeRoute({ tags: ["gym"], summary: "Policies of a skill", responses: ok }),
    validator("param", tenantIdParam), isTenantMember,
    async (c) => {
      try {
        const { tenantId, id } = c.req.valid("param");
        return c.json(await listPolicies(tenantId, id));
      } catch (e) { throw toHttpError(e); }
    });

  app.post(`${base}/:id/policies`, ...guard,
    describeRoute({ tags: ["gym"], summary: "Add a policy to a skill", responses: ok }),
    validator("param", tenantIdParam), isTenantMember,
    async (c) => {
      try {
        const { tenantId, id } = c.req.valid("param");
        return c.json(await createPolicy(tenantId, await actorOf(c), id, await c.req.json()), 201);
      } catch (e) { throw toHttpError(e); }
    });

  app.put(`${API_BASE_PATH}/tenant/:tenantId/gym/policies/:id`, ...guard,
    describeRoute({ tags: ["gym"], summary: "Update a policy", responses: ok }),
    validator("param", tenantIdParam), isTenantMember,
    async (c) => {
      try {
        const { tenantId, id } = c.req.valid("param");
        return c.json(await updatePolicy(tenantId, await actorOf(c), id, await c.req.json()));
      } catch (e) { throw toHttpError(e); }
    });

  app.delete(`${API_BASE_PATH}/tenant/:tenantId/gym/policies/:id`, ...guard,
    describeRoute({ tags: ["gym"], summary: "Delete a policy", responses: ok }),
    validator("param", tenantIdParam), isTenantMember,
    async (c) => {
      try {
        const { tenantId, id } = c.req.valid("param");
        await deletePolicy(tenantId, await actorOf(c), id);
        return c.body(null, 204);
      } catch (e) { throw toHttpError(e); }
    });
}
