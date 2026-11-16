/**
 * The strategy of a skill: description, pictures and PDFs, the run sheet.
 *
 *   GET    /tenant/:tenantId/gym/skills/:id/strategy
 *   PUT    /tenant/:tenantId/gym/skills/:id/strategy                  { text }
 *   POST   /tenant/:tenantId/gym/skills/:id/strategy/files            multipart "file": png, jpeg, webp or pdf
 *   GET    /tenant/:tenantId/gym/skills/:id/strategy/files/:fileId    the bytes
 *   DELETE /tenant/:tenantId/gym/skills/:id/strategy/files/:fileId
 *   PUT    /tenant/:tenantId/gym/skills/:id/strategy/run-sheet        { fileName, csv, groupBy }
 *   DELETE /tenant/:tenantId/gym/skills/:id/strategy/run-sheet
 *
 * Every write answers with the whole strategy as it is stored now.
 */
import type { SymbiosikaFrameworkHonoApp } from "@framework/types";
import { authAndSetUsersInfo, checkUserPermission } from "@framework/lib/utils/hono-middlewares";
import { isTenantMember } from "@framework/routes/tenant";
import { HTTPException } from "hono/http-exception";
import { describeRoute, validator } from "hono-openapi";
import * as v from "valibot";
import {
  addStrategyFile,
  getStrategy,
  getStrategyFile,
  removeRunSheet,
  removeStrategyFile,
  setRunSheet,
  updateStrategyText,
} from "../../../../lib/gym/strategy";
import { actorOf, ok, tenantIdParam, toHttpError } from "./_shared";

const fileParam = v.object({
  tenantId: v.pipe(v.string(), v.uuid()),
  id: v.pipe(v.string(), v.uuid()),
  fileId: v.pipe(v.string(), v.uuid()),
});

export default function defineStrategyRoutes(app: SymbiosikaFrameworkHonoApp, API_BASE_PATH = "") {
  const base = `${API_BASE_PATH}/tenant/:tenantId/gym/skills/:id/strategy`;
  const guard = [authAndSetUsersInfo, checkUserPermission] as const;

  app.get(base, ...guard,
    describeRoute({ tags: ["gym"], summary: "The strategy of a skill: description, files and run sheet", responses: ok }),
    validator("param", tenantIdParam), isTenantMember,
    async (c) => {
      try {
        const { tenantId, id } = c.req.valid("param");
        return c.json(await getStrategy(tenantId, id));
      } catch (e) { throw toHttpError(e); }
    });

  app.put(base, ...guard,
    describeRoute({ tags: ["gym"], summary: "Save the written description of the strategy", responses: ok }),
    validator("param", tenantIdParam), isTenantMember,
    async (c) => {
      try {
        const { tenantId, id } = c.req.valid("param");
        return c.json(await updateStrategyText(tenantId, await actorOf(c), id, await c.req.json()));
      } catch (e) { throw toHttpError(e); }
    });

  app.post(`${base}/files`, ...guard,
    describeRoute({ tags: ["gym"], summary: "Add a picture or a PDF to the strategy", responses: ok }),
    validator("param", tenantIdParam), isTenantMember,
    async (c) => {
      try {
        const { tenantId, id } = c.req.valid("param");
        const body = await c.req.parseBody();
        const file = body["file"];
        if (!(file instanceof File)) throw new HTTPException(400, { message: "Multipart field 'file' is required" });
        return c.json(await addStrategyFile(tenantId, await actorOf(c), id, file));
      } catch (e) { throw toHttpError(e); }
    });

  app.get(`${base}/files/:fileId`, ...guard,
    describeRoute({ tags: ["gym"], summary: "One file of the strategy", responses: ok }),
    validator("param", fileParam), isTenantMember,
    async (c) => {
      try {
        const { tenantId, id, fileId } = c.req.valid("param");
        const { file, meta } = await getStrategyFile(tenantId, id, fileId);
        return c.body(await file.arrayBuffer(), 200, {
          "Content-Type": meta.mime,
          "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(meta.name)}`,
          "Cache-Control": "private, max-age=60",
          // a stored file is shown, never run: no sniffing it into something else
          "X-Content-Type-Options": "nosniff",
        });
      } catch (e) { throw toHttpError(e); }
    });

  app.delete(`${base}/files/:fileId`, ...guard,
    describeRoute({ tags: ["gym"], summary: "Remove a file of the strategy", responses: ok }),
    validator("param", fileParam), isTenantMember,
    async (c) => {
      try {
        const { tenantId, id, fileId } = c.req.valid("param");
        return c.json(await removeStrategyFile(tenantId, await actorOf(c), id, fileId));
      } catch (e) { throw toHttpError(e); }
    });

  app.put(`${base}/run-sheet`, ...guard,
    describeRoute({ tags: ["gym"], summary: "Read a CSV into the skill's run sheet", responses: ok }),
    validator("param", tenantIdParam), isTenantMember,
    async (c) => {
      try {
        const { tenantId, id } = c.req.valid("param");
        return c.json(await setRunSheet(tenantId, await actorOf(c), id, await c.req.json()));
      } catch (e) { throw toHttpError(e); }
    });

  app.delete(`${base}/run-sheet`, ...guard,
    describeRoute({ tags: ["gym"], summary: "Remove the skill's run sheet", responses: ok }),
    validator("param", tenantIdParam), isTenantMember,
    async (c) => {
      try {
        const { tenantId, id } = c.req.valid("param");
        return c.json(await removeRunSheet(tenantId, await actorOf(c), id));
      } catch (e) { throw toHttpError(e); }
    });
}
