/**
 * The guided tour: one skill per organisation that shows a whole iteration of
 * GYM on real data (spec, recording, selection, export, policy, evaluation,
 * report). An admin chooses it; the tour only reads it.
 *
 * `tourMaterial` picks from that skill what each chapter of the tour looks
 * at: the newest recording block whose data the critics judged, its largest
 * finished dataset, the newest export, the policy, the newest evaluation with
 * reviewed rollouts, the newest report. A kind the skill has none of is null,
 * and the tour skips the steps that need it.
 */
import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";
import * as v from "valibot";
import { getDb } from "@framework/lib/db/db-connection";
import { blocks, datasets, episodes, evaluationReports, exports, policies, skills } from "../../db/schema";
import { specExists } from "../critics/specs";
import { recordAudit, type Actor } from "./audit";
import { NotFoundError } from "./errors";

export interface TourMaterial {
  skill: { id: string; name: string; criticSpecName: string | null; status: string } | null;
  /** the newest recording block with a dataset the critics finished, a closed one first */
  recordingBlockId: string | null;
  /** the finished dataset of that block with the most episodes */
  datasetId: string | null;
  /** the newest export of the skill */
  exportId: string | null;
  /** the newest policy, one trained from an export first */
  policyId: string | null;
  /** the newest evaluation block with a finished dataset, one with reviewed rollouts first */
  evaluationBlockId: string | null;
  /** the newest evaluation report of the skill */
  reportId: string | null;
  /** the skill names a spec that is stored, so the spec manager can open it */
  specStored: boolean;
}

const EMPTY: TourMaterial = {
  skill: null,
  recordingBlockId: null,
  datasetId: null,
  exportId: null,
  policyId: null,
  evaluationBlockId: null,
  reportId: null,
  specStored: false,
};

const setTourSkillSchema = v.object({ skillId: v.nullable(v.pipe(v.string(), v.uuid())) });

/** Choose the tour skill of the organisation, or none (`skillId: null`). Owners and admins; the route checks. */
export async function setTourSkill(tenantId: string, actor: Actor, input: unknown): Promise<TourMaterial> {
  const { skillId } = v.parse(setTourSkillSchema, input);
  const db = getDb();
  if (skillId) {
    const [skill] = await db
      .select({ id: skills.id })
      .from(skills)
      .where(and(eq(skills.id, skillId), eq(skills.tenantId, tenantId)));
    if (!skill) throw new NotFoundError("Skill");
  }
  const now = new Date().toISOString();
  // one at most: the old one goes first, the unique index would refuse two
  await db
    .update(skills)
    .set({ tourSkill: false, updatedAt: now })
    .where(and(eq(skills.tenantId, tenantId), eq(skills.tourSkill, true)));
  if (skillId) await db.update(skills).set({ tourSkill: true, updatedAt: now }).where(and(eq(skills.id, skillId), eq(skills.tenantId, tenantId)));
  await recordAudit(tenantId, { skillId }, actor, "tour.skill.set", { skillId });
  return tourMaterial(tenantId);
}

/** What the tour shows of the tour skill. Every field but `skill` may be null; without a tour skill all are. */
export async function tourMaterial(tenantId: string): Promise<TourMaterial> {
  const db = getDb();
  const [skill] = await db
    .select({ id: skills.id, name: skills.name, criticSpecName: skills.criticSpecName, status: skills.status })
    .from(skills)
    .where(and(eq(skills.tenantId, tenantId), eq(skills.tourSkill, true)));
  if (!skill) return { ...EMPTY };

  // the finished datasets of the skill with their block: the recording and the evaluation side
  const done = await db
    .select({
      datasetId: datasets.id,
      episodeCount: datasets.episodeCount,
      blockId: blocks.id,
      kind: blocks.kind,
      closedAt: blocks.closedAt,
      blockCreatedAt: blocks.createdAt,
    })
    .from(datasets)
    .innerJoin(blocks, eq(blocks.id, datasets.blockId))
    .where(and(eq(datasets.tenantId, tenantId), eq(datasets.skillId, skill.id), eq(datasets.analysisStatus, "done")));

  /** closed blocks first, then the newest */
  const newestFirst = (a: (typeof done)[number], b: (typeof done)[number]) =>
    Number(!!b.closedAt) - Number(!!a.closedAt) || b.blockCreatedAt.localeCompare(a.blockCreatedAt);

  const recording = done.filter((d) => d.kind === "recording").sort(newestFirst);
  const recordingBlockId = recording[0]?.blockId ?? null;
  const datasetId = recording.filter((d) => d.blockId === recordingBlockId).sort((a, b) => b.episodeCount - a.episodeCount)[0]?.datasetId ?? null;

  const evaluation = done.filter((d) => d.kind === "evaluation");
  const reviewed = evaluation.length
    ? new Set(
        (
          await db
            .selectDistinct({ datasetId: episodes.datasetId })
            .from(episodes)
            .where(and(inArray(episodes.datasetId, evaluation.map((d) => d.datasetId)), isNotNull(episodes.humanVerdict)))
        ).map((r) => r.datasetId),
      )
    : new Set<string>();
  const evaluationBlockId =
    evaluation.sort((a, b) => Number(reviewed.has(b.datasetId)) - Number(reviewed.has(a.datasetId)) || newestFirst(a, b))[0]?.blockId ?? null;

  const [exportRow] = await db
    .select({ id: exports.id })
    .from(exports)
    .where(and(eq(exports.tenantId, tenantId), eq(exports.skillId, skill.id)))
    .orderBy(desc(exports.createdAt))
    .limit(1);
  const policyRows = await db
    .select({ id: policies.id, exportId: policies.exportId })
    .from(policies)
    .where(and(eq(policies.tenantId, tenantId), eq(policies.skillId, skill.id)))
    .orderBy(desc(policies.createdAt));
  const [report] = await db
    .select({ id: evaluationReports.id })
    .from(evaluationReports)
    .where(and(eq(evaluationReports.tenantId, tenantId), eq(evaluationReports.skillId, skill.id)))
    .orderBy(desc(evaluationReports.createdAt))
    .limit(1);

  const specStored = skill.criticSpecName ? await specExists(tenantId, skill.criticSpecName).catch(() => false) : false;

  return {
    skill,
    recordingBlockId,
    datasetId,
    exportId: exportRow?.id ?? null,
    policyId: (policyRows.find((p) => p.exportId) ?? policyRows[0])?.id ?? null,
    evaluationBlockId,
    reportId: report?.id ?? null,
    specStored,
  };
}
