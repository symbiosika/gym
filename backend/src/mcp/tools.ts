/**
 * Gym MCP tools for the analyst (a person or an AI agent). Schemas are
 * valibot; handlers go through the app's HTTP API in process, so every
 * route-level permission check applies. All tools are read-only.
 */
import * as v from "valibot";
import type { McpToolDefinition } from "@framework/types";
import { API_BASE_PATH, callApi, fail, ok, READ_ONLY, tenantPath } from "./api";

const tenantArg = v.optional(v.pipe(v.string(), v.uuid()), undefined);
const uuid = v.pipe(v.string(), v.uuid());
const isoDate = v.optional(v.pipe(v.string(), v.regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD")));
const limit = v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(5000)));

export const gymTools: McpToolDefinition[] = [
  {
    name: "whoami",
    title: "Who am I",
    description: "The signed-in user and their organisations. Call once at the start; the organisation id is the tenantId other tools accept.",
    annotations: READ_ONLY,
    handler: async (_args, ctx) => {
      const me = await ctx.fetchApi(`${API_BASE_PATH}/user/me`);
      const tenants = await ctx.fetchApi(`${API_BASE_PATH}/user/tenants`);
      if (!me.ok) return fail(`API ${me.status}: could not read the user`);
      const user = (await me.json()) as Record<string, unknown>;
      return ok({
        user: { id: user.id, email: user.email, firstname: user.firstname, surname: user.surname },
        boundTenantId: ctx.tenantId ?? null,
        organisations: tenants.ok ? await tenants.json() : [],
      });
    },
  },
  {
    name: "list_cells",
    title: "List cells",
    description: "The training cells of the organisation.",
    inputSchema: v.object({ tenantId: tenantArg }),
    annotations: READ_ONLY,
    handler: (args, ctx) => callApi(ctx, tenantPath(ctx, "/gym/cells", args.tenantId)),
  },
  {
    name: "list_collections",
    title: "List collections",
    description: "Collections (customer projects, use cases) with their skill count.",
    inputSchema: v.object({ tenantId: tenantArg }),
    annotations: READ_ONLY,
    handler: (args, ctx) => callApi(ctx, tenantPath(ctx, "/gym/collections", args.tenantId)),
  },
  {
    name: "list_skills",
    title: "List skills",
    description:
      "Skills (what is trained) with their figures: recording and evaluation blocks, days worked, recording datasets and episodes (accepted, review, rejected, selected), policies, the newest evaluation's success rate. Newest activity first. Filter by status or collection.",
    inputSchema: v.object({
      tenantId: tenantArg,
      status: v.optional(v.picklist(["active", "archived"])),
      collectionId: v.optional(uuid),
      limit,
    }),
    annotations: READ_ONLY,
    handler: (args, ctx) => callApi(ctx, tenantPath(ctx, "/gym/skills", args.tenantId), { query: { status: args.status, collectionId: args.collectionId, limit: args.limit } }),
  },
  {
    name: "get_skill",
    title: "Get a skill",
    description:
      "One skill with every block (by day, with datasets and analyses), its exports, its policies and its evaluations: per evaluation block the date, cell, policy, judged rollouts, accepted rollouts and success rate. The place to see when a skill was trained, when it was evaluated and how the success rate moved.",
    inputSchema: v.object({ tenantId: tenantArg, skillId: uuid }),
    annotations: READ_ONLY,
    handler: (args, ctx) => callApi(ctx, tenantPath(ctx, `/gym/skills/${args.skillId}`, args.tenantId)),
  },
  {
    name: "get_skill_audit",
    title: "Audit log of a skill",
    description: "Every recorded action that concerns the skill with user and timestamp, newest first.",
    inputSchema: v.object({ tenantId: tenantArg, skillId: uuid }),
    annotations: READ_ONLY,
    handler: (args, ctx) => callApi(ctx, tenantPath(ctx, `/gym/skills/${args.skillId}/audit`, args.tenantId)),
  },
  {
    name: "list_day_protocols",
    title: "List day protocols",
    description: "Day protocols (one per cell and day, the controlling record) with their blocks, newest first. Filter by date range (YYYY-MM-DD), cell or skill.",
    inputSchema: v.object({ tenantId: tenantArg, from: isoDate, to: isoDate, cellId: v.optional(uuid), skillId: v.optional(uuid), limit }),
    annotations: READ_ONLY,
    handler: (args, ctx) =>
      callApi(ctx, tenantPath(ctx, "/gym/days", args.tenantId), { query: { from: args.from, to: args.to, cellId: args.cellId, skillId: args.skillId, limit: args.limit } }),
  },
  {
    name: "get_day_protocol",
    title: "Get a day protocol",
    description:
      "One day protocol: cell, date, operator, the downtimes written down by hand, notes, and its blocks (recording or evaluation, for which skill, with brief, plan, progress, the windows and their sum, datasets with analyses, episode totals). The times of the day are summed over the blocks and kept apart: teleop minutes, evaluation minutes, recorded seconds, downtime minutes.",
    inputSchema: v.object({ tenantId: tenantArg, dayProtocolId: uuid }),
    annotations: READ_ONLY,
    handler: (args, ctx) => callApi(ctx, tenantPath(ctx, `/gym/days/${args.dayProtocolId}`, args.tenantId)),
  },
  {
    name: "get_day_protocol_audit",
    title: "Audit log of a day protocol",
    description: "Every recorded action that concerns the day protocol or one of its blocks, newest first.",
    inputSchema: v.object({ tenantId: tenantArg, dayProtocolId: uuid }),
    annotations: READ_ONLY,
    handler: (args, ctx) => callApi(ctx, tenantPath(ctx, `/gym/days/${args.dayProtocolId}/audit`, args.tenantId)),
  },
  {
    name: "list_blocks",
    title: "List blocks",
    description: "Blocks (one stretch of work for one skill, recording or evaluation), newest first. Filter by skill, day protocol or kind.",
    inputSchema: v.object({ tenantId: tenantArg, skillId: v.optional(uuid), dayProtocolId: v.optional(uuid), kind: v.optional(v.picklist(["recording", "evaluation"])), limit }),
    annotations: READ_ONLY,
    handler: (args, ctx) =>
      callApi(ctx, tenantPath(ctx, "/gym/blocks", args.tenantId), { query: { skillId: args.skillId, dayProtocolId: args.dayProtocolId, kind: args.kind, limit: args.limit } }),
  },
  {
    name: "get_block",
    title: "Get a block",
    description: "One block with its skill, policy, brief, plan, progress, windows, datasets with analyses and episode totals.",
    inputSchema: v.object({ tenantId: tenantArg, blockId: uuid }),
    annotations: READ_ONLY,
    handler: (args, ctx) => callApi(ctx, tenantPath(ctx, `/gym/blocks/${args.blockId}`, args.tenantId)),
  },
  {
    name: "get_dataset",
    title: "Get a dataset",
    description:
      "One dataset with the critics' summary (counts, flags, run-level findings, recording-session profile), the critics' selection.json and every episode (verdict accept/review/reject, scores, flags, why it was filtered, operator selection).",
    inputSchema: v.object({ tenantId: tenantArg, datasetId: uuid }),
    annotations: READ_ONLY,
    handler: (args, ctx) => callApi(ctx, tenantPath(ctx, `/gym/datasets/${args.datasetId}`, args.tenantId)),
  },
  {
    name: "get_dataset_report",
    title: "Critics report of a dataset",
    description: "The full report.json of the lerobot-critics run: every critic's score, flags, metrics and evidence per episode, dataset statistics, session profile. Large; prefer get_dataset unless you need the metrics.",
    inputSchema: v.object({ tenantId: tenantArg, datasetId: uuid }),
    annotations: READ_ONLY,
    handler: (args, ctx) => callApi(ctx, tenantPath(ctx, `/gym/datasets/${args.datasetId}/report`, args.tenantId)),
  },
  {
    name: "get_dataset_markdown",
    title: "Critics run as Markdown",
    description: "The critics run of a dataset as self-contained, AI-readable Markdown from the lerobot-critics service: scoring explained, checks that ran, glossary of flags, per-episode results. detail: summary | flagged | full.",
    inputSchema: v.object({ tenantId: tenantArg, datasetId: uuid, detail: v.optional(v.picklist(["summary", "flagged", "full"])) }),
    annotations: READ_ONLY,
    handler: async (args, ctx) => {
      const res = await ctx.fetchApi(tenantPath(ctx, `/gym/datasets/${args.datasetId}/markdown?detail=${args.detail ?? "summary"}`, args.tenantId));
      if (!res.ok) return fail(`API ${res.status}: ${await res.text()}`);
      return ok(await res.text());
    },
  },
  {
    name: "get_skill_selection",
    title: "Episode selection of a skill",
    description: "Every episode of every recording dataset of the skill with the critics' verdict, the operator's verdict where a person overruled it (humanVerdict; the effective verdict is humanVerdict, else verdict) and the operator's selection. Evaluation rollouts are not part of it.",
    inputSchema: v.object({ tenantId: tenantArg, skillId: uuid }),
    annotations: READ_ONLY,
    handler: (args, ctx) => callApi(ctx, tenantPath(ctx, `/gym/skills/${args.skillId}/selection`, args.tenantId)),
  },
  {
    name: "get_block_rollouts",
    title: "Rollouts of an evaluation block",
    description:
      "Every rollout of an evaluation block with the critics' verdict, the human reviewer's verdict where a person overruled it, the effective verdict, the failure code (F-01 grasp failure … F-08 hardware, not charged to the policy), the reviewer's note and the plan variation the rollout ran in; plus the block's totals: success rate with the Wilson 95 % interval, policy-attributable rate, rollouts still waiting for a human decision, failure counts.",
    inputSchema: v.object({ tenantId: tenantArg, blockId: uuid }),
    annotations: READ_ONLY,
    handler: (args, ctx) => callApi(ctx, tenantPath(ctx, `/gym/blocks/${args.blockId}/rollouts`, args.tenantId)),
  },
  {
    name: "list_evaluation_reports",
    title: "Evaluation reports of a skill",
    description: "The evaluation reports of a skill: name, the evaluation blocks each one reads together, when it was written. Newest first.",
    inputSchema: v.object({ tenantId: tenantArg, skillId: uuid }),
    annotations: READ_ONLY,
    handler: (args, ctx) => callApi(ctx, tenantPath(ctx, `/gym/skills/${args.skillId}/evaluation-reports`, args.tenantId)),
  },
  {
    name: "get_evaluation_report",
    title: "Get an evaluation report",
    description:
      "One evaluation report with its written sections (prompt, success criteria, design, reset, caveats, what is working, what needs review, next steps) and its figures computed from the blocks it covers: overall success with the Wilson interval, success per block (a checkpoint or a policy on a day) and per plan variation, the block × variation matrix, failure modes per block, the best block, the top failure and every rollout with critics' and human verdict.",
    inputSchema: v.object({ tenantId: tenantArg, reportId: uuid }),
    annotations: READ_ONLY,
    handler: (args, ctx) => callApi(ctx, tenantPath(ctx, `/gym/evaluation-reports/${args.reportId}`, args.tenantId)),
  },
  {
    name: "get_kpis",
    title: "Key figures",
    description:
      "How much, how good, how fast: skills, days, blocks, recording datasets, episodes (accepted, review, rejected, selected), accept rate, teleoperation minutes, recorded seconds, downtime minutes and episodes per hour for a period, per cell and per day; the evaluations apart (blocks, judged rollouts, accepted, success rate, minutes); plus the most frequent findings and the runs whose vision-language model did not answer. Filter by cell, collection or skill.",
    inputSchema: v.object({ tenantId: tenantArg, from: isoDate, to: isoDate, cellId: v.optional(uuid), collectionId: v.optional(uuid), skillId: v.optional(uuid) }),
    annotations: READ_ONLY,
    handler: (args, ctx) =>
      callApi(ctx, tenantPath(ctx, "/gym/kpis", args.tenantId), { query: { from: args.from, to: args.to, cellId: args.cellId, collectionId: args.collectionId, skillId: args.skillId } }),
  },
];
