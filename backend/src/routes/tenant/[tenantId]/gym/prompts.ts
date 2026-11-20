/**
 * Prompts and shortcuts: the prompt check of a dataset, the corrected prompts
 * and paraphrases, and the shortcut figures over a skill's selection. The
 * judging is the data critics' (`/analyses/*`), GYM saves what people decide.
 *
 *   GET /tenant/:tenantId/gym/skills/:id/selection/shortcuts?datasetId  the shortcut figures over the selection (or one dataset of it)
 *   PUT /tenant/:tenantId/gym/skills/:id/prompt-variants                { [prompt]: { variants, keepOriginal } }: the skill's paraphrases
 *   GET /tenant/:tenantId/gym/datasets/:id/prompts                      the prompt check of a dataset
 *   PUT /tenant/:tenantId/gym/datasets/:id/prompts                      { episodes: [{ index, prompt|null }] }: set or give back prompts
 */
import type { SymbiosikaFrameworkHonoApp } from "@framework/types";
import { authAndSetUsersInfo, checkUserPermission } from "@framework/lib/utils/hono-middlewares";
import { isTenantMember } from "@framework/routes/tenant";
import { describeRoute, validator } from "hono-openapi";
import * as v from "valibot";
import { getPromptCheck, setPrompts, setPromptVariants } from "../../../../lib/gym/prompts";
import { getSelectionShortcuts } from "../../../../lib/gym/shortcuts";
import { actorOf, ok, tenantIdParam, toHttpError } from "./_shared";

const shortcutQuery = v.object({ datasetId: v.optional(v.pipe(v.string(), v.uuid())) });

export default function definePromptRoutes(app: SymbiosikaFrameworkHonoApp, API_BASE_PATH = "") {
  const skills = `${API_BASE_PATH}/tenant/:tenantId/gym/skills`;
  const ds = `${API_BASE_PATH}/tenant/:tenantId/gym/datasets`;
  const guard = [authAndSetUsersInfo, checkUserPermission] as const;

  app.get(`${skills}/:id/selection/shortcuts`, ...guard,
    describeRoute({ tags: ["gym"], summary: "What a policy could learn instead of the prompt, over the selection (the critics' figures)", responses: ok }),
    validator("param", tenantIdParam), validator("query", shortcutQuery), isTenantMember,
    async (c) => {
      try {
        const { tenantId, id } = c.req.valid("param");
        return c.json(await getSelectionShortcuts(tenantId, id, c.req.valid("query").datasetId ?? null));
      } catch (e) { throw toHttpError(e); }
    });

  app.put(`${skills}/:id/prompt-variants`, ...guard,
    describeRoute({ tags: ["gym"], summary: "Replace the skill's paraphrases per prompt", responses: ok }),
    validator("param", tenantIdParam), isTenantMember,
    async (c) => {
      try {
        const { tenantId, id } = c.req.valid("param");
        return c.json(await setPromptVariants(tenantId, await actorOf(c), id, await c.req.json()));
      } catch (e) { throw toHttpError(e); }
    });

  app.get(`${ds}/:id/prompts`, ...guard,
    describeRoute({ tags: ["gym"], summary: "Does every episode's prompt fit what it picked? (the critics' prompt check)", responses: ok }),
    validator("param", tenantIdParam), isTenantMember,
    async (c) => {
      try {
        const { tenantId, id } = c.req.valid("param");
        return c.json(await getPromptCheck(tenantId, id));
      } catch (e) { throw toHttpError(e); }
    });

  app.put(`${ds}/:id/prompts`, ...guard,
    describeRoute({ tags: ["gym"], summary: "Set the prompt of episodes; null gives an episode its recorded prompt back", responses: ok }),
    validator("param", tenantIdParam), isTenantMember,
    async (c) => {
      try {
        const { tenantId, id } = c.req.valid("param");
        return c.json(await setPrompts(tenantId, await actorOf(c), id, await c.req.json()));
      } catch (e) { throw toHttpError(e); }
    });
}
