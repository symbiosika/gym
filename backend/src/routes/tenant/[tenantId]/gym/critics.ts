/**
 * The critics service as the operator and the analyst see it through GYM.
 *
 *   GET /tenant/:tenantId/gym/critics                      reachable? health, specs
 *   GET /tenant/:tenantId/gym/critics/specs                 the specs with the skills that use them
 *   GET /tenant/:tenantId/gym/critics/specs/:name           one spec as YAML, for the editor
 *   PUT /tenant/:tenantId/gym/critics/specs/:name           { text }: the spec as YAML or JSON
 *   DELETE /tenant/:tenantId/gym/critics/specs/:name        remove a spec from the critics service
 *   GET /tenant/:tenantId/gym/critics/spec-template         the starting point of a new spec
 *   GET /tenant/:tenantId/gym/critics/hard-critics          the technical checks with their default parameters, for the spec editor
 *   POST /tenant/:tenantId/gym/critics/specs                multipart "file": a spec as YAML or JSON (+ name)
 *   PUT /tenant/:tenantId/gym/datasets/:id/findings        { reviewFlags, ignoreFlags }: downgrade findings, the critics replay the verdicts
 *   GET /tenant/:tenantId/gym/datasets/:id/report          the mirrored report.json
 *   GET /tenant/:tenantId/gym/datasets/:id/report.html     the visual report (proxied)
 *   GET /tenant/:tenantId/gym/datasets/:id/markdown?detail the AI-readable Markdown (proxied)
 *   GET /tenant/:tenantId/gym/datasets/:id/files/*         contact sheets, composites, csv (proxied)
 */
import type { SymbiosikaFrameworkHonoApp } from "@framework/types";
import { authAndSetUsersInfo, checkUserPermission } from "@framework/lib/utils/hono-middlewares";
import { isTenantMember } from "@framework/routes/tenant";
import { HTTPException } from "hono/http-exception";
import { describeRoute, validator } from "hono-openapi";
import * as v from "valibot";
import { criticsBaseUrl, criticsClient } from "../../../../lib/critics/client";
import { deleteSpec, getSpec, hardCritics, saveSpecText, specTemplate, uploadSpec } from "../../../../lib/critics/specs";
import { specUsage } from "../../../../lib/gym/skills";
import { getDatasetRow, setFindingOverrides } from "../../../../lib/gym/datasets";
import { actorOf, ok, tenantIdParam, tenantParam, toHttpError } from "./_shared";

/**
 * The critics render the report's links to its artifacts (report.md, the csv
 * files, selection.json, the composite videos) against their own
 * `/jobs/{id}/files/` path. Through GYM the page is served at
 * `.../datasets/:id/report.html`, so those links have to point at the
 * `.../datasets/:id/files/` proxy next to it: relative, so the API base path
 * does not matter. Anything else in the page (embedded images, styles) stays.
 */
export const gymReportLinks = (html: string): string => html.replace(/(href|src)="\/jobs\/[^/"]+\/files\//g, '$1="files/');

export default function defineCriticsRoutes(app: SymbiosikaFrameworkHonoApp, API_BASE_PATH = "") {
  const dsBase = `${API_BASE_PATH}/tenant/:tenantId/gym/datasets`;
  const guard = [authAndSetUsersInfo, checkUserPermission] as const;

  app.get(`${API_BASE_PATH}/tenant/:tenantId/gym/critics`, ...guard,
    describeRoute({ tags: ["gym"], summary: "State of the data critics service", responses: ok }),
    validator("param", tenantParam), isTenantMember,
    async (c) => {
      try {
        const health = await criticsClient.health();
        const specs = await criticsClient.specs().catch(() => []);
        return c.json({ reachable: true, url: criticsBaseUrl(), health, specs });
      } catch (error) {
        return c.json({ reachable: false, url: criticsBaseUrl(), health: null, specs: [], error: error instanceof Error ? error.message : String(error) });
      }
    });

  const specBase = `${API_BASE_PATH}/tenant/:tenantId/gym/critics/specs`;
  const specParam = v.object({ tenantId: v.pipe(v.string(), v.uuid()), name: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(200)) });

  app.get(`${API_BASE_PATH}/tenant/:tenantId/gym/critics/spec-template`, ...guard,
    describeRoute({ tags: ["gym"], summary: "A starting point for a new critics spec", responses: ok }),
    validator("param", tenantParam), isTenantMember,
    async (c) => c.json({ yaml: specTemplate() }));

  app.get(`${API_BASE_PATH}/tenant/:tenantId/gym/critics/hard-critics`, ...guard,
    describeRoute({ tags: ["gym"], summary: "The technical checks of the critics with their default parameters", responses: ok }),
    validator("param", tenantParam), isTenantMember,
    async (c) => c.json(await hardCritics()));

  app.get(specBase, ...guard,
    describeRoute({ tags: ["gym"], summary: "The stored critics specs with the skills that use them", responses: ok }),
    validator("param", tenantParam), isTenantMember,
    async (c) => {
      try {
        const { tenantId } = c.req.valid("param");
        const [specs, usage] = await Promise.all([criticsClient.specs(), specUsage(tenantId)]);
        return c.json(specs.map((spec) => ({ ...spec, usedBy: usage[spec.name] ?? [] })));
      } catch (e) { throw toHttpError(e); }
    });

  app.get(`${specBase}/:name`, ...guard,
    describeRoute({ tags: ["gym"], summary: "One critics spec as YAML", responses: ok }),
    validator("param", specParam), isTenantMember,
    async (c) => {
      try {
        const { tenantId, name } = c.req.valid("param");
        return c.json({ ...(await getSpec(name)), usedBy: (await specUsage(tenantId))[name] ?? [] });
      } catch (e) { throw toHttpError(e); }
    });

  app.put(`${specBase}/:name`, ...guard,
    describeRoute({ tags: ["gym"], summary: "Write a critics spec (YAML or JSON text)", responses: ok }),
    validator("param", specParam), validator("json", v.object({ text: v.pipe(v.string(), v.maxLength(1_000_000)) })), isTenantMember,
    async (c) => {
      try {
        const { name } = c.req.valid("param");
        return c.json(await saveSpecText(name, c.req.valid("json").text));
      } catch (e) { throw toHttpError(e); }
    });

  app.delete(`${specBase}/:name`, ...guard,
    describeRoute({ tags: ["gym"], summary: "Remove a critics spec from the critics service", responses: ok }),
    validator("param", specParam), isTenantMember,
    async (c) => {
      try {
        await deleteSpec(c.req.valid("param").name);
        return c.json({ ok: true });
      } catch (e) { throw toHttpError(e); }
    });

  app.post(`${API_BASE_PATH}/tenant/:tenantId/gym/critics/specs`, ...guard,
    describeRoute({ tags: ["gym"], summary: "Upload a critics spec (YAML or JSON) into the critics service", responses: ok }),
    validator("param", tenantParam), isTenantMember,
    async (c) => {
      try {
        const body = await c.req.parseBody();
        const file = body["file"];
        if (!(file instanceof File)) throw new HTTPException(400, { message: "Multipart field 'file' (a YAML or JSON spec) is required" });
        const name = typeof body["name"] === "string" ? body["name"] : undefined;
        return c.json(await uploadSpec(file, name), 201);
      } catch (e) { throw toHttpError(e); }
    });

  const jobOf = async (tenantId: string, id: string) => {
    const ds = await getDatasetRow(tenantId, id);
    if (!ds.criticsJobId) throw new HTTPException(404, { message: "The dataset has no critics run" });
    return ds;
  };

  app.put(`${dsBase}/:id/findings`, ...guard,
    describeRoute({ tags: ["gym"], summary: "Downgrade findings of a run (review = warning, ignore = informational); the critics replay the verdicts", responses: ok }),
    validator("param", tenantIdParam), isTenantMember,
    async (c) => {
      try {
        const { tenantId, id } = c.req.valid("param");
        return c.json(await setFindingOverrides(tenantId, await actorOf(c), id, await c.req.json()));
      } catch (e) { throw toHttpError(e); }
    });

  app.get(`${dsBase}/:id/report`, ...guard,
    describeRoute({ tags: ["gym"], summary: "The critics' report.json of a dataset", responses: ok }),
    validator("param", tenantIdParam), isTenantMember,
    async (c) => {
      try {
        const { tenantId, id } = c.req.valid("param");
        const ds = await getDatasetRow(tenantId, id);
        if (!ds.report) throw new HTTPException(404, { message: "No report yet" });
        return c.json(ds.report);
      } catch (e) { throw toHttpError(e); }
    });

  app.get(`${dsBase}/:id/report.html`, ...guard,
    describeRoute({ tags: ["gym"], summary: "The visual report of the critics run", responses: ok }),
    validator("param", tenantIdParam), validator("query", v.object({ top: v.optional(v.string()) })), isTenantMember,
    async (c) => {
      try {
        const { tenantId, id } = c.req.valid("param");
        const ds = await jobOf(tenantId, id);
        const top = Number(c.req.valid("query").top ?? 5) || 5;
        return c.html(gymReportLinks(await criticsClient.reportHtml(ds.criticsJobId!, top)));
      } catch (e) { throw toHttpError(e); }
    });

  app.get(`${dsBase}/:id/markdown`, ...guard,
    describeRoute({ tags: ["gym"], summary: "The critics run as AI-readable Markdown", responses: ok }),
    validator("param", tenantIdParam), validator("query", v.object({ detail: v.optional(v.picklist(["summary", "flagged", "full"]), "summary") })), isTenantMember,
    async (c) => {
      try {
        const { tenantId, id } = c.req.valid("param");
        const ds = await jobOf(tenantId, id);
        return c.text(await criticsClient.markdown(ds.criticsJobId!, c.req.valid("query").detail), 200, { "Content-Type": "text/markdown; charset=utf-8" });
      } catch (e) { throw toHttpError(e); }
    });

  app.get(`${dsBase}/:id/files/*`, ...guard,
    describeRoute({ tags: ["gym"], summary: "An artifact of the critics run (contact sheet, composite, csv)", responses: ok }),
    validator("param", tenantIdParam), isTenantMember,
    async (c) => {
      try {
        const { tenantId, id } = c.req.valid("param");
        const ds = await jobOf(tenantId, id);
        const path = c.req.path.split(`/files/`).slice(1).join("/files/");
        if (!path || path.includes("..")) throw new HTTPException(400, { message: "Invalid path" });
        const upstream = await criticsClient.file(ds.criticsJobId!, path);
        return new Response(upstream.body, {
          status: 200,
          headers: { "Content-Type": upstream.headers.get("content-type") ?? "application/octet-stream", "Cache-Control": "private, max-age=300" },
        });
      } catch (e) { throw toHttpError(e); }
    });
}
