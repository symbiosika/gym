/**
 * Evaluation reports: evaluation blocks of a skill read together.
 *
 * One block is one evaluation: a policy ran in a cell on a day, N rollouts,
 * a success rate. A report puts one or more of them next to each other, for
 * example the checkpoints of one training run (8k, 11k, 13k) evaluated in the
 * same campaign, and reads success by block, by variation of the plan, the
 * failure modes and every single rollout. The team writes the parts a
 * database cannot know (prompt, success criteria, design, caveats,
 * conclusions); everything else is computed from the blocks' rollouts, the
 * critics' verdicts and the human review whenever the report is read, so a
 * later review changes the report at once.
 *
 * A report has a share id: the read-only, printable view is public like the
 * day protocol's print view, so it can be sent to a customer.
 */
import { and, desc, eq, inArray } from "drizzle-orm";
import * as v from "valibot";
import { getDb } from "@framework/lib/db/db-connection";
import { blocks, collections, EMPTY_REPORT_SECTIONS, evaluationReports, skills, type EvaluationReportSections, type EvaluationReportSelect } from "../../db/schema";
import { recordAudit, type Actor } from "./audit";
import { InvalidInputError, NotFoundError } from "./errors";
import { aggregate, loadRollouts, rolloutBlockInfos, type EvaluationFigures } from "./evaluations";
import { getSkillRow } from "./skills";
import { utcRow, utcRows } from "./time";
import { newShareId } from "./tokens";

const sectionText = v.optional(v.pipe(v.string(), v.maxLength(8000)));
const sectionsSchema = v.object({
  prompt: sectionText,
  successCriteria: sectionText,
  design: sectionText,
  reset: sectionText,
  caveats: sectionText,
  working: sectionText,
  needsReview: sectionText,
  nextSteps: sectionText,
});

export const reportInputSchema = v.object({
  name: v.pipe(v.string(), v.trim(), v.minLength(1, "Name is required"), v.maxLength(300)),
  /** evaluation blocks of the skill, in report order */
  blockIds: v.pipe(v.array(v.pipe(v.string(), v.uuid())), v.minLength(1, "Pick at least one evaluation block"), v.maxLength(100)),
  sections: v.optional(sectionsSchema),
});

export const updateReportSchema = v.object({
  name: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(300))),
  blockIds: v.optional(v.pipe(v.array(v.pipe(v.string(), v.uuid())), v.minLength(1), v.maxLength(100))),
  sections: v.optional(sectionsSchema),
});

/** A report as listed on the skill. */
export type EvaluationReportRecord = EvaluationReportSelect;

/** A report with its figures and the skill it belongs to. */
export interface EvaluationReportView extends EvaluationReportRecord {
  skill: { id: string; name: string; taskDescription: string; collectionName: string | null };
  figures: EvaluationFigures;
}

/** The public, read-only view: no ids of the organisation beyond the share id. */
export interface PublicEvaluationReport {
  shareId: string;
  name: string;
  skill: { name: string; taskDescription: string; collectionName: string | null };
  sections: EvaluationReportSections;
  figures: EvaluationFigures;
  createdAt: string;
  updatedAt: string;
}

const mergeSections = (base: EvaluationReportSections, patch?: Partial<EvaluationReportSections>): EvaluationReportSections => {
  const out = { ...EMPTY_REPORT_SECTIONS, ...base };
  for (const [k, value] of Object.entries(patch ?? {})) if (value !== undefined) out[k as keyof EvaluationReportSections] = value.trim();
  return out;
};

/** The blocks must be evaluation blocks of the skill; the order of `blockIds` is kept. */
async function evaluationBlocksOf(tenantId: string, skillId: string, blockIds: string[]) {
  const rows = blockIds.length
    ? await getDb()
        .select()
        .from(blocks)
        .where(and(eq(blocks.tenantId, tenantId), eq(blocks.skillId, skillId), inArray(blocks.id, blockIds)))
    : [];
  const byId = new Map(rows.map((r) => [r.id, r]));
  const missing = blockIds.find((id) => !byId.has(id));
  if (missing) throw new InvalidInputError(`Block ${missing} is not a block of this skill`);
  const notEvaluation = rows.find((r) => r.kind !== "evaluation");
  if (notEvaluation) throw new InvalidInputError("An evaluation report reads evaluation blocks only");
  return blockIds.map((id) => byId.get(id)!);
}

export async function listReports(tenantId: string, skillId: string): Promise<EvaluationReportRecord[]> {
  const rows = await getDb()
    .select()
    .from(evaluationReports)
    .where(and(eq(evaluationReports.tenantId, tenantId), eq(evaluationReports.skillId, skillId)))
    .orderBy(desc(evaluationReports.createdAt));
  return utcRows(rows);
}

export async function getReportRow(tenantId: string, id: string): Promise<EvaluationReportSelect> {
  const rows = await getDb()
    .select()
    .from(evaluationReports)
    .where(and(eq(evaluationReports.id, id), eq(evaluationReports.tenantId, tenantId)))
    .limit(1);
  if (!rows[0]) throw new NotFoundError("Evaluation report");
  return rows[0];
}

/** The figures of a report, from its blocks as they are now. Blocks that were deleted since are left out. */
async function figuresOf(row: EvaluationReportSelect): Promise<EvaluationFigures> {
  const blockRows = row.blockIds.length
    ? await getDb()
        .select()
        .from(blocks)
        .where(and(eq(blocks.tenantId, row.tenantId), inArray(blocks.id, row.blockIds)))
    : [];
  const byId = new Map(blockRows.map((b) => [b.id, b]));
  const ordered = row.blockIds.map((id) => byId.get(id)).filter((b): b is NonNullable<typeof b> => !!b);
  const infos = await rolloutBlockInfos(ordered);
  return aggregate(infos, await loadRollouts(infos));
}

async function skillOf(row: EvaluationReportSelect) {
  const rows = await getDb()
    .select({ name: skills.name, taskDescription: skills.taskDescription, collectionName: collections.name })
    .from(skills)
    .leftJoin(collections, eq(collections.id, skills.collectionId))
    .where(eq(skills.id, row.skillId))
    .limit(1);
  const s = rows[0];
  return { id: row.skillId, name: s?.name ?? "", taskDescription: s?.taskDescription ?? "", collectionName: s?.collectionName ?? null };
}

export async function getReport(tenantId: string, id: string): Promise<EvaluationReportView> {
  const row = await getReportRow(tenantId, id);
  return { ...utcRow(row), sections: mergeSections(row.sections), skill: await skillOf(row), figures: await figuresOf(row) };
}

export async function getReportByShareId(shareId: string): Promise<PublicEvaluationReport> {
  const rows = await getDb().select().from(evaluationReports).where(eq(evaluationReports.shareId, shareId)).limit(1);
  const row = rows[0];
  if (!row) throw new NotFoundError("Evaluation report");
  const skill = await skillOf(row);
  const out = utcRow(row);
  return {
    shareId: row.shareId,
    name: row.name,
    skill: { name: skill.name, taskDescription: skill.taskDescription, collectionName: skill.collectionName },
    sections: mergeSections(row.sections),
    figures: await figuresOf(row),
    createdAt: out.createdAt,
    updatedAt: out.updatedAt,
  };
}

export async function createReport(tenantId: string, actor: Actor, skillId: string, input: unknown): Promise<EvaluationReportView> {
  await getSkillRow(tenantId, skillId);
  const data = v.parse(reportInputSchema, input);
  await evaluationBlocksOf(tenantId, skillId, data.blockIds);
  const [row] = await getDb()
    .insert(evaluationReports)
    .values({
      tenantId,
      skillId,
      name: data.name,
      blockIds: [...new Set(data.blockIds)],
      sections: mergeSections(EMPTY_REPORT_SECTIONS, data.sections),
      shareId: newShareId(),
      createdBy: actor.userId,
    })
    .returning();
  await recordAudit(tenantId, { skillId }, actor, "evaluation.report.created", { reportId: row!.id, name: row!.name, blocks: row!.blockIds.length });
  return getReport(tenantId, row!.id);
}

export async function updateReport(tenantId: string, actor: Actor, id: string, input: unknown): Promise<EvaluationReportView> {
  const data = v.parse(updateReportSchema, input);
  const row = await getReportRow(tenantId, id);
  const patch: Partial<EvaluationReportSelect> = { updatedAt: new Date().toISOString() };
  if (data.name !== undefined) patch.name = data.name;
  if (data.blockIds !== undefined) {
    await evaluationBlocksOf(tenantId, row.skillId, data.blockIds);
    patch.blockIds = [...new Set(data.blockIds)];
  }
  if (data.sections !== undefined) patch.sections = mergeSections(row.sections, data.sections);
  await getDb().update(evaluationReports).set(patch).where(eq(evaluationReports.id, id));
  await recordAudit(tenantId, { skillId: row.skillId }, actor, "evaluation.report.updated", {
    reportId: id,
    ...(data.name !== undefined ? { name: data.name } : {}),
    ...(data.blockIds !== undefined ? { blocks: data.blockIds.length } : {}),
    ...(data.sections !== undefined ? { sections: Object.keys(data.sections) } : {}),
  });
  return getReport(tenantId, id);
}

export async function deleteReport(tenantId: string, actor: Actor, id: string): Promise<void> {
  const row = await getReportRow(tenantId, id);
  await getDb().delete(evaluationReports).where(eq(evaluationReports.id, id));
  await recordAudit(tenantId, { skillId: row.skillId }, actor, "evaluation.report.deleted", { reportId: id, name: row.name });
}
