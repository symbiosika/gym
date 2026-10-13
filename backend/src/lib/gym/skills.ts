/**
 * Skills: what is trained. A skill has a task, the critics spec its datasets
 * are judged with, its recording blocks over all days and cells, the episode
 * selection and the exports built from it, and its policies (trained
 * versions). Evaluation blocks test a policy of the skill.
 *
 * A skill has no cell and no dates of its own: those belong to the day
 * protocols and their blocks. The figures here are sums over them.
 */
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import * as v from "valibot";
import { getDb } from "@framework/lib/db/db-connection";
import {
  blocks,
  collections,
  datasets,
  dayProtocols,
  episodes,
  exports,
  policies,
  skills,
  SKILL_STATUSES,
  type BlockSelect,
  type PolicySelect,
  type SkillSelect,
} from "../../db/schema";
import { recordAudit, type Actor } from "./audit";
import { toBlockViews, type BlockView } from "./blocks";
import { InvalidInputError, NotFoundError } from "./errors";
import { effectiveVerdictSql } from "./evaluations";
import { teleopMinutes } from "./teleop";
import { utcRow, utcRows } from "./time";

export const skillInputSchema = v.object({
  name: v.pipe(v.string(), v.trim(), v.minLength(1, "Name is required"), v.maxLength(200)),
  collectionId: v.optional(v.nullable(v.pipe(v.string(), v.uuid())), null),
  taskDescription: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(4000)), ""),
  /** stored spec of the critics service to analyse the datasets with; null = auto spec */
  criticSpecName: v.optional(v.nullable(v.pipe(v.string(), v.trim(), v.maxLength(200))), null),
});

export const updateSkillSchema = v.object({
  name: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(200))),
  collectionId: v.optional(v.nullable(v.pipe(v.string(), v.uuid()))),
  taskDescription: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(4000))),
  criticSpecName: v.optional(v.nullable(v.pipe(v.string(), v.trim(), v.maxLength(200)))),
  status: v.optional(v.picklist(SKILL_STATUSES)),
});

/** One evaluation of a skill: an evaluation block with what came out of it. */
export interface EvaluationSummary {
  blockId: string;
  dayProtocolId: string;
  date: string;
  cellName: string;
  policyId: string | null;
  policyName: string | null;
  step: BlockSelect["step"];
  /** rollouts the operator planned */
  targetEpisodes: number | null;
  datasets: number;
  /** rollouts the critics judged */
  episodes: number;
  accepted: number;
  review: number;
  rejected: number;
  /** accepted / episodes; null while nothing was analysed */
  successRatePercent: number | null;
  minutes: number;
}

export interface SkillListItem extends SkillSelect {
  collectionName: string | null;
  /** blocks of the skill by kind */
  recordingBlocks: number;
  evaluationBlocks: number;
  /** distinct days the skill was worked on */
  days: number;
  firstDate: string | null;
  lastDate: string | null;
  /** recording datasets and their episodes; evaluations are counted apart */
  datasets: number;
  episodes: number;
  acceptedEpisodes: number;
  reviewEpisodes: number;
  rejectedEpisodes: number;
  selectedEpisodes: number;
  policies: number;
  /** the newest evaluation with a judged rollout, for the list */
  lastEvaluation: { date: string; successRatePercent: number | null; policyName: string | null } | null;
}

export interface SkillView extends SkillListItem {
  blocks_: BlockView[];
  exports: (typeof exports.$inferSelect)[];
  policies_: PolicySelect[];
  evaluations: EvaluationSummary[];
}

interface ListFilter {
  status?: (typeof SKILL_STATUSES)[number];
  collectionId?: string;
  limit?: number;
}

const round1 = (x: number) => Math.round(x * 10) / 10;

/** The evaluations of the given skills, newest first. */
async function evaluationsOf(tenantId: string, skillIds: string[]): Promise<Map<string, EvaluationSummary[]>> {
  const out = new Map<string, EvaluationSummary[]>();
  if (!skillIds.length) return out;
  const rows = await getDb()
    .select({ block: blocks, date: dayProtocols.date, cellName: sql<string>`(select name from gym_cells where id = ${dayProtocols.cellId})`, policyName: policies.name })
    .from(blocks)
    .innerJoin(dayProtocols, eq(dayProtocols.id, blocks.dayProtocolId))
    .leftJoin(policies, eq(policies.id, blocks.policyId))
    .where(and(eq(blocks.tenantId, tenantId), inArray(blocks.skillId, skillIds), eq(blocks.kind, "evaluation")))
    .orderBy(desc(dayProtocols.date), desc(blocks.createdAt));
  if (!rows.length) return out;
  const agg = await getDb()
    .select({
      blockId: datasets.blockId,
      datasets: sql<number>`count(distinct ${datasets.id})`,
      episodes: sql<number>`count(${episodes.id})`,
      // the human review of a rollout counts over the critics' verdict
      accepted: sql<number>`count(*) filter (where ${effectiveVerdictSql} = 'accept')`,
      review: sql<number>`count(*) filter (where ${effectiveVerdictSql} = 'review')`,
      rejected: sql<number>`count(*) filter (where ${effectiveVerdictSql} = 'reject')`,
    })
    .from(datasets)
    .leftJoin(episodes, eq(episodes.datasetId, datasets.id))
    .where(inArray(datasets.blockId, rows.map((r) => r.block.id)))
    .groupBy(datasets.blockId);
  const byBlock = new Map(agg.map((a) => [a.blockId, a]));
  const now = Date.now();
  for (const r of rows) {
    const a = byBlock.get(r.block.id);
    const eps = Number(a?.episodes ?? 0);
    const accepted = Number(a?.accepted ?? 0);
    const item: EvaluationSummary = {
      blockId: r.block.id,
      dayProtocolId: r.block.dayProtocolId,
      date: r.date,
      cellName: r.cellName,
      policyId: r.block.policyId,
      policyName: r.policyName ?? null,
      step: r.block.step,
      targetEpisodes: r.block.targetEpisodes,
      datasets: Number(a?.datasets ?? 0),
      episodes: eps,
      accepted,
      review: Number(a?.review ?? 0),
      rejected: Number(a?.rejected ?? 0),
      successRatePercent: eps ? round1((accepted / eps) * 100) : null,
      minutes: Math.round(teleopMinutes(r.block, now)),
    };
    out.set(r.block.skillId, [...(out.get(r.block.skillId) ?? []), item]);
  }
  return out;
}

/** Skills with their figures, newest activity first. */
export async function listSkills(tenantId: string, filter: ListFilter = {}): Promise<SkillListItem[]> {
  const conditions = [eq(skills.tenantId, tenantId)];
  if (filter.status) conditions.push(eq(skills.status, filter.status));
  if (filter.collectionId) conditions.push(eq(skills.collectionId, filter.collectionId));
  const rows = await getDb()
    .select({ skill: skills, collectionName: collections.name })
    .from(skills)
    .leftJoin(collections, eq(collections.id, skills.collectionId))
    .where(and(...conditions))
    .orderBy(desc(skills.createdAt))
    .limit(filter.limit ?? 500);
  if (!rows.length) return [];
  const ids = rows.map((r) => r.skill.id);
  const blockAgg = await getDb()
    .select({
      skillId: blocks.skillId,
      recording: sql<number>`count(*) filter (where ${blocks.kind} = 'recording')`,
      evaluation: sql<number>`count(*) filter (where ${blocks.kind} = 'evaluation')`,
      days: sql<number>`count(distinct ${blocks.dayProtocolId})`,
      firstDate: sql<string>`min(${dayProtocols.date})`,
      lastDate: sql<string>`max(${dayProtocols.date})`,
    })
    .from(blocks)
    .innerJoin(dayProtocols, eq(dayProtocols.id, blocks.dayProtocolId))
    .where(inArray(blocks.skillId, ids))
    .groupBy(blocks.skillId);
  // recording datasets only: an evaluation's rollouts are not training material
  const dsAgg = await getDb()
    .select({ skillId: datasets.skillId, datasets: sql<number>`count(*)` })
    .from(datasets)
    .innerJoin(blocks, eq(blocks.id, datasets.blockId))
    .where(and(inArray(datasets.skillId, ids), eq(blocks.kind, "recording")))
    .groupBy(datasets.skillId);
  const epAgg = await getDb()
    .select({
      skillId: episodes.skillId,
      episodes: sql<number>`count(*)`,
      accepted: sql<number>`count(*) filter (where ${effectiveVerdictSql} = 'accept')`,
      review: sql<number>`count(*) filter (where ${effectiveVerdictSql} = 'review')`,
      rejected: sql<number>`count(*) filter (where ${effectiveVerdictSql} = 'reject')`,
      selected: sql<number>`count(*) filter (where ${episodes.selected})`,
    })
    .from(episodes)
    .innerJoin(datasets, eq(datasets.id, episodes.datasetId))
    .innerJoin(blocks, eq(blocks.id, datasets.blockId))
    .where(and(inArray(episodes.skillId, ids), eq(blocks.kind, "recording")))
    .groupBy(episodes.skillId);
  const polAgg = await getDb()
    .select({ skillId: policies.skillId, n: sql<number>`count(*)` })
    .from(policies)
    .where(inArray(policies.skillId, ids))
    .groupBy(policies.skillId);
  const evals = await evaluationsOf(tenantId, ids);

  const byBlock = new Map(blockAgg.map((d) => [d.skillId, d]));
  const ds = new Map(dsAgg.map((d) => [d.skillId, Number(d.datasets)]));
  const ep = new Map(epAgg.map((d) => [d.skillId, d]));
  const pol = new Map(polAgg.map((d) => [d.skillId, Number(d.n)]));
  const items = rows.map((r) => {
    const b = byBlock.get(r.skill.id);
    const e = ep.get(r.skill.id);
    const lastEval = (evals.get(r.skill.id) ?? []).find((x) => x.episodes > 0) ?? null;
    return {
      ...utcRow(r.skill),
      collectionName: r.collectionName ?? null,
      recordingBlocks: Number(b?.recording ?? 0),
      evaluationBlocks: Number(b?.evaluation ?? 0),
      days: Number(b?.days ?? 0),
      firstDate: b?.firstDate ?? null,
      lastDate: b?.lastDate ?? null,
      datasets: ds.get(r.skill.id) ?? 0,
      episodes: Number(e?.episodes ?? 0),
      acceptedEpisodes: Number(e?.accepted ?? 0),
      reviewEpisodes: Number(e?.review ?? 0),
      rejectedEpisodes: Number(e?.rejected ?? 0),
      selectedEpisodes: Number(e?.selected ?? 0),
      policies: pol.get(r.skill.id) ?? 0,
      lastEvaluation: lastEval ? { date: lastEval.date, successRatePercent: lastEval.successRatePercent, policyName: lastEval.policyName } : null,
    };
  });
  return items.sort((a, b) => (b.lastDate ?? "").localeCompare(a.lastDate ?? "") || b.createdAt.localeCompare(a.createdAt));
}

export async function getSkillRow(tenantId: string, id: string): Promise<SkillSelect> {
  const rows = await getDb()
    .select()
    .from(skills)
    .where(and(eq(skills.id, id), eq(skills.tenantId, tenantId)))
    .limit(1);
  if (!rows[0]) throw new NotFoundError("Skill");
  return rows[0];
}

/** One skill with its blocks (oldest day first), figures, exports, policies and evaluations. */
export async function getSkill(tenantId: string, id: string): Promise<SkillView> {
  const list = await listSkills(tenantId, { limit: 5000 });
  const item = list.find((s) => s.id === id);
  if (!item) throw new NotFoundError("Skill");
  const blockRows = await getDb()
    .select({ block: blocks })
    .from(blocks)
    .innerJoin(dayProtocols, eq(dayProtocols.id, blocks.dayProtocolId))
    .where(and(eq(blocks.skillId, id), eq(blocks.tenantId, tenantId)))
    .orderBy(asc(dayProtocols.date), asc(blocks.createdAt));
  const blocks_ = await toBlockViews(blockRows.map((r) => r.block));
  const exportRows = await getDb()
    .select()
    .from(exports)
    .where(and(eq(exports.skillId, id), eq(exports.tenantId, tenantId)))
    .orderBy(desc(exports.createdAt));
  const policies_ = await listPolicies(tenantId, id);
  const evaluations = (await evaluationsOf(tenantId, [id])).get(id) ?? [];
  return { ...item, blocks_, exports: utcRows(exportRows), policies_, evaluations };
}

export async function createSkill(tenantId: string, actor: Actor, input: unknown): Promise<SkillSelect> {
  const data = v.parse(skillInputSchema, input);
  if (data.collectionId) {
    const col = await getDb().select({ id: collections.id }).from(collections).where(and(eq(collections.id, data.collectionId), eq(collections.tenantId, tenantId))).limit(1);
    if (!col[0]) throw new InvalidInputError("Unknown collection");
  }
  const [row] = await getDb()
    .insert(skills)
    .values({ tenantId, ...data, createdBy: actor.userId })
    .returning();
  await recordAudit(tenantId, { skillId: row!.id }, actor, "skill.created", { name: row!.name });
  return utcRow(row!);
}

export async function updateSkill(tenantId: string, actor: Actor, id: string, input: unknown): Promise<SkillSelect> {
  const data = v.parse(updateSkillSchema, input);
  const [row] = await getDb()
    .update(skills)
    .set({ ...data, updatedAt: new Date().toISOString() })
    .where(and(eq(skills.id, id), eq(skills.tenantId, tenantId)))
    .returning();
  if (!row) throw new NotFoundError("Skill");
  await recordAudit(tenantId, { skillId: id }, actor, data.status ? `skill.${data.status === "archived" ? "archived" : "updated"}` : "skill.updated", data);
  return utcRow(row);
}

/**
 * Deleting a skill removes its blocks, datasets, episodes, exports, policies
 * and audit log. The day protocols the blocks were part of stay: they are the
 * cell's record, not the skill's.
 */
export async function deleteSkill(tenantId: string, id: string): Promise<void> {
  const deleted = await getDb()
    .delete(skills)
    .where(and(eq(skills.id, id), eq(skills.tenantId, tenantId)))
    .returning({ id: skills.id });
  if (!deleted.length) throw new NotFoundError("Skill");
}

/**
 * Which skills a critics spec is used by, spec name to skill names. The spec
 * management shows it, so removing a spec is never a surprise: a skill that
 * names a spec the service no longer has falls back to the automatic spec on
 * its next upload.
 */
export async function specUsage(tenantId: string): Promise<Record<string, string[]>> {
  const rows = await getDb()
    .select({ name: skills.name, spec: skills.criticSpecName })
    .from(skills)
    .where(eq(skills.tenantId, tenantId))
    .orderBy(asc(skills.name));
  const out: Record<string, string[]> = {};
  for (const row of rows) if (row.spec) (out[row.spec] ??= []).push(row.name);
  return out;
}

// ---------------------------------------------------------------------------
// Policies
// ---------------------------------------------------------------------------

export const policyInputSchema = v.object({
  name: v.pipe(v.string(), v.trim(), v.minLength(1, "Name is required"), v.maxLength(200)),
  exportId: v.optional(v.nullable(v.pipe(v.string(), v.uuid())), null),
  notes: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(4000)), ""),
  /** ISO timestamp of the training's end; null when unknown */
  trainedAt: v.optional(v.nullable(v.string()), null),
});

const trainedAtOf = (value: string | null | undefined): string | null => {
  if (!value) return null;
  const t = new Date(value);
  if (Number.isNaN(t.getTime())) throw new InvalidInputError("trainedAt is not a date");
  return t.toISOString();
};

export async function listPolicies(tenantId: string, skillId: string): Promise<PolicySelect[]> {
  const rows = await getDb()
    .select()
    .from(policies)
    .where(and(eq(policies.skillId, skillId), eq(policies.tenantId, tenantId)))
    .orderBy(desc(policies.trainedAt), desc(policies.createdAt));
  return utcRows(rows);
}

export async function getPolicyRow(tenantId: string, id: string): Promise<PolicySelect> {
  const rows = await getDb()
    .select()
    .from(policies)
    .where(and(eq(policies.id, id), eq(policies.tenantId, tenantId)))
    .limit(1);
  if (!rows[0]) throw new NotFoundError("Policy");
  return rows[0];
}

export async function createPolicy(tenantId: string, actor: Actor, skillId: string, input: unknown): Promise<PolicySelect> {
  await getSkillRow(tenantId, skillId);
  const data = v.parse(policyInputSchema, input);
  if (data.exportId) {
    const ex = await getDb().select({ id: exports.id }).from(exports).where(and(eq(exports.id, data.exportId), eq(exports.skillId, skillId))).limit(1);
    if (!ex[0]) throw new InvalidInputError("The export does not belong to this skill");
  }
  const [row] = await getDb()
    .insert(policies)
    .values({ tenantId, skillId, name: data.name, exportId: data.exportId, notes: data.notes, trainedAt: trainedAtOf(data.trainedAt), createdBy: actor.userId })
    .returning();
  await recordAudit(tenantId, { skillId }, actor, "policy.created", { policyId: row!.id, name: row!.name, exportId: data.exportId });
  return utcRow(row!);
}

export async function updatePolicy(tenantId: string, actor: Actor, id: string, input: unknown): Promise<PolicySelect> {
  const data = v.parse(v.partial(policyInputSchema), input);
  const row = await getPolicyRow(tenantId, id);
  if (data.exportId) {
    const ex = await getDb().select({ id: exports.id }).from(exports).where(and(eq(exports.id, data.exportId), eq(exports.skillId, row.skillId))).limit(1);
    if (!ex[0]) throw new InvalidInputError("The export does not belong to this skill");
  }
  const patch: Partial<PolicySelect> = { updatedAt: new Date().toISOString() };
  if (data.name !== undefined) patch.name = data.name;
  if (data.exportId !== undefined) patch.exportId = data.exportId;
  if (data.notes !== undefined) patch.notes = data.notes;
  if (data.trainedAt !== undefined) patch.trainedAt = trainedAtOf(data.trainedAt);
  const [updated] = await getDb().update(policies).set(patch).where(eq(policies.id, id)).returning();
  await recordAudit(tenantId, { skillId: row.skillId }, actor, "policy.updated", { policyId: id, ...data });
  return utcRow(updated!);
}

/** Evaluation blocks that tested the policy keep their data and lose the reference. */
export async function deletePolicy(tenantId: string, actor: Actor, id: string): Promise<void> {
  const row = await getPolicyRow(tenantId, id);
  await getDb().delete(policies).where(eq(policies.id, id));
  await recordAudit(tenantId, { skillId: row.skillId }, actor, "policy.deleted", { policyId: id, name: row.name });
}
