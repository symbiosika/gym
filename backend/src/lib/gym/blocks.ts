/**
 * Blocks: the unit of the operator wizard.
 *
 * A block is one stretch of work in a day protocol for one skill: a recording
 * block (teleoperation, the datasets train the skill) or an evaluation block
 * (a policy runs, its rollouts are recorded and judged). A block walks through
 * the steps of `BlockStep`, storing every input on the way so a browser
 * restart resumes it. Two things reach a block from outside the signed-in
 * browser: the mobile views (scene photo, recording run), identified by the
 * block's access token, see `resolveAccessToken`.
 */
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import * as v from "valibot";
import { getDb } from "@framework/lib/db/db-connection";
import { putFile, readFile, removeFile } from "../storage";
import { SCENE_IMAGE_BUCKET, UPLOAD_CHUNK_BUCKET, VARIATION_IMAGE_BUCKET } from "./buckets";
import {
  BLOCK_KINDS,
  BLOCK_STEPS,
  blocks,
  cells,
  datasetUploadChunks,
  datasetUploads,
  datasets,
  dayProtocols,
  episodes,
  policies,
  skills,
  type BlockKind,
  type BlockSelect,
  type BlockStep,
  type DatasetAnalysisStatus,
  type DayProtocolSelect,
  type PlanStep,
  type PlanVariation,
  type PlanVariationImage,
  type RecordingPlan,
  type RecordingProgress,
  type SkillSelect,
} from "../../db/schema";
import { editSceneImage, getGymImageModel, ImageGenerationError, isImageGenerationEnabled, variationImagePrompt } from "../ai/images";
import { fallbackPlan, plainPlan, proposeFollowUp, proposeRecordingPlan, newStepId, type Language } from "../ai/plan";
import type { CriticsSummary } from "../critics/summary";
import { criticsClient } from "../critics/client";
import { blocksWithOpenDatasets, syncOpenDatasets, upgradeStaleSummariesOf } from "../critics/sync";
import { recordAudit, SYSTEM_ACTOR, type Actor, type AuditRefs } from "./audit";
import { getCell } from "./cells";
import { ensureDay, getDayRow } from "./day-protocols";
import { ConflictError, InvalidInputError, NotFoundError, TokenError, UpstreamError } from "./errors";
import { effectiveVerdictSql } from "./evaluations";
import { getPolicyRow, getSkillRow } from "./skills";
import { blockTimes, closeIntervals, openInterval, teleopMinutes as teleopMinutesOf, type BlockTimes } from "./teleop";
import { isoDate, utcIso, utcRow } from "./time";
import { ACCESS_TOKEN_TTL_MS, newAccessToken } from "./tokens";


// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

export interface DatasetSummary {
  id: string;
  name: string;
  episodeCount: number;
  analysisStatus: DatasetAnalysisStatus;
  analysisError: string | null;
  progress: Record<string, { done: number; total: number }> | null;
  criticsJobId: string | null;
  analysis: CriticsSummary | null;
  createdAt: string;
}

export interface EpisodeTotals {
  episodes: number;
  accepted: number;
  review: number;
  rejected: number;
  selected: number;
  /** sum of the episode durations of the datasets, the recorded elapsed time */
  recordedSeconds: number | null;
}

/** A block as the API returns it: no secrets, with its context. */
export type BlockView = Omit<BlockSelect, "accessToken" | "accessTokenExpiresAt"> & {
  /** the day the block belongs to */
  date: string;
  cell: { id: string; name: string; location: string };
  operatorName: string;
  shareId: string;
  skill: { id: string; name: string; status: string; taskDescription: string; collectionId: string | null; criticSpecName: string | null };
  policy: { id: string; name: string } | null;
  hasSceneImage: boolean;
  datasets: DatasetSummary[];
  totals: EpisodeTotals;
  /** the block's time, the recorded time of its uploads */
  times: BlockTimes;
};

const refsOf = (row: BlockSelect): AuditRefs => ({ skillId: row.skillId, dayProtocolId: row.dayProtocolId, blockId: row.id });

/**
 * The verdicts are counted on the effective verdict: the human review of a
 * rollout, where there is one, else the critics' word (lib/gym/evaluations.ts).
 */
async function totalsFor(blockIds: string[]): Promise<Map<string, EpisodeTotals>> {
  const out = new Map<string, EpisodeTotals>();
  if (!blockIds.length) return out;
  const rows = await getDb()
    .select({
      blockId: datasets.blockId,
      episodes: sql<number>`count(${episodes.id})`,
      accepted: sql<number>`count(*) filter (where ${effectiveVerdictSql} = 'accept')`,
      review: sql<number>`count(*) filter (where ${effectiveVerdictSql} = 'review')`,
      rejected: sql<number>`count(*) filter (where ${effectiveVerdictSql} = 'reject')`,
      selected: sql<number>`count(*) filter (where ${episodes.selected})`,
      recordedSeconds: sql<number | null>`sum(${episodes.durationSeconds})`,
    })
    .from(datasets)
    .innerJoin(episodes, eq(episodes.datasetId, datasets.id))
    .where(inArray(datasets.blockId, blockIds))
    .groupBy(datasets.blockId);
  for (const r of rows) {
    out.set(r.blockId, {
      episodes: Number(r.episodes),
      accepted: Number(r.accepted),
      review: Number(r.review),
      rejected: Number(r.rejected),
      selected: Number(r.selected),
      recordedSeconds: r.recordedSeconds == null ? null : Number(r.recordedSeconds),
    });
  }
  return out;
}

const NO_EPISODES: EpisodeTotals = { episodes: 0, accepted: 0, review: 0, rejected: 0, selected: 0, recordedSeconds: null };

export async function toBlockView(row: BlockSelect): Promise<BlockView> {
  const views = await toBlockViews([row]);
  return views[0]!;
}

export async function toBlockViews(rows: BlockSelect[]): Promise<BlockView[]> {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  // bring open critics runs up to date before showing them
  const open = await blocksWithOpenDatasets(ids);
  if (open.size) await syncOpenDatasets([...open]);

  const dayRows = await getDb().select().from(dayProtocols).where(inArray(dayProtocols.id, [...new Set(rows.map((r) => r.dayProtocolId))]));
  const dayById = new Map(dayRows.map((d) => [d.id, d]));
  const cellRows = await getDb().select().from(cells).where(inArray(cells.id, [...new Set(dayRows.map((d) => d.cellId))]));
  const cellById = new Map(cellRows.map((c) => [c.id, c]));
  const skillRows = await getDb().select().from(skills).where(inArray(skills.id, [...new Set(rows.map((r) => r.skillId))]));
  const skillById = new Map(skillRows.map((s) => [s.id, s]));
  const policyIds = [...new Set(rows.map((r) => r.policyId).filter((x): x is string => !!x))];
  const policyRows = policyIds.length ? await getDb().select({ id: policies.id, name: policies.name }).from(policies).where(inArray(policies.id, policyIds)) : [];
  const policyById = new Map(policyRows.map((p) => [p.id, p]));
  // summaries built before the current shape are rebuilt from the stored report first
  const dsIds = await getDb().select({ id: datasets.id }).from(datasets).where(inArray(datasets.blockId, ids));
  await upgradeStaleSummariesOf(dsIds.map((d) => d.id));
  const dsRows = await getDb()
    .select({
      id: datasets.id,
      blockId: datasets.blockId,
      name: datasets.name,
      episodeCount: datasets.episodeCount,
      analysisStatus: datasets.analysisStatus,
      analysisError: datasets.analysisError,
      progress: datasets.progress,
      criticsJobId: datasets.criticsJobId,
      analysis: datasets.analysis,
      createdAt: datasets.createdAt,
    })
    .from(datasets)
    .where(inArray(datasets.blockId, ids))
    .orderBy(asc(datasets.createdAt));
  const totals = await totalsFor(ids);
  const now = Date.now();
  return rows.map((row) => {
    const { accessToken: _t, accessTokenExpiresAt: _e, ...rest } = utcRow(row);
    const day = dayById.get(row.dayProtocolId);
    const cell = day ? cellById.get(day.cellId) : undefined;
    const skill = skillById.get(row.skillId);
    const policy = row.policyId ? policyById.get(row.policyId) : undefined;
    const t = totals.get(row.id) ?? NO_EPISODES;
    return {
      ...rest,
      date: day?.date ?? "",
      cell: { id: day?.cellId ?? "", name: cell?.name ?? "", location: cell?.location ?? "" },
      operatorName: day?.operatorName ?? "",
      shareId: day?.shareId ?? "",
      skill: {
        id: row.skillId,
        name: skill?.name ?? "",
        status: skill?.status ?? "active",
        taskDescription: skill?.taskDescription ?? "",
        collectionId: skill?.collectionId ?? null,
        criticSpecName: skill?.criticSpecName ?? null,
      },
      policy: policy ? { id: policy.id, name: policy.name } : null,
      hasSceneImage: !!row.sceneImageRef,
      datasets: dsRows
        .filter((d) => d.blockId === row.id)
        .map((d) => ({
          id: d.id,
          name: d.name,
          episodeCount: d.episodeCount,
          analysisStatus: d.analysisStatus,
          analysisError: d.analysisError,
          progress: d.progress ?? null,
          criticsJobId: d.criticsJobId,
          analysis: d.analysis ?? null,
          createdAt: utcIso(d.createdAt)!,
        })),
      totals: t,
      times: blockTimes(row, t.recordedSeconds, now),
    };
  });
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export async function getBlockRow(tenantId: string, id: string): Promise<BlockSelect> {
  const rows = await getDb()
    .select()
    .from(blocks)
    .where(and(eq(blocks.id, id), eq(blocks.tenantId, tenantId)))
    .limit(1);
  if (!rows[0]) throw new NotFoundError("Block");
  return rows[0];
}

export const getBlock = async (tenantId: string, id: string): Promise<BlockView> => toBlockView(await getBlockRow(tenantId, id));

export interface BlockFilter {
  skillId?: string;
  dayProtocolId?: string;
  kind?: BlockKind;
  limit?: number;
}

/** Blocks, newest first. */
export async function listBlocks(tenantId: string, filter: BlockFilter = {}): Promise<BlockView[]> {
  const conditions = [eq(blocks.tenantId, tenantId)];
  if (filter.skillId) conditions.push(eq(blocks.skillId, filter.skillId));
  if (filter.dayProtocolId) conditions.push(eq(blocks.dayProtocolId, filter.dayProtocolId));
  if (filter.kind) conditions.push(eq(blocks.kind, filter.kind));
  const rows = await getDb()
    .select()
    .from(blocks)
    .where(and(...conditions))
    .orderBy(desc(blocks.createdAt))
    .limit(filter.limit ?? 500);
  return toBlockViews(rows);
}

// ---------------------------------------------------------------------------
// Start a block
// ---------------------------------------------------------------------------

export const startBlockSchema = v.object({
  cellId: v.pipe(v.string(), v.uuid()),
  skillId: v.pipe(v.string(), v.uuid()),
  kind: v.optional(v.picklist(BLOCK_KINDS), "recording"),
  /** the policy an evaluation tests; must belong to the skill */
  policyId: v.optional(v.nullable(v.pipe(v.string(), v.uuid())), null),
  /** YYYY-MM-DD; defaults to today in the gym's time zone */
  date: v.optional(v.pipe(v.string(), v.regex(/^\d{4}-\d{2}-\d{2}$/))),
});

/** The newest block of the skill with the given kind, to pre-fill a new one. */
async function lastBlockOf(skillId: string, kind: BlockKind): Promise<BlockSelect | null> {
  const rows = await getDb()
    .select({ block: blocks })
    .from(blocks)
    .innerJoin(dayProtocols, eq(dayProtocols.id, blocks.dayProtocolId))
    .where(and(eq(blocks.skillId, skillId), eq(blocks.kind, kind)))
    .orderBy(desc(dayProtocols.date), desc(blocks.createdAt))
    .limit(1);
  return rows[0]?.block ?? null;
}

/**
 * Start a block in a cell for a skill. The day protocol of the cell and date
 * is created when it is missing (and reopened when it was closed); the brief
 * and the plan are carried over from the skill's newest block of the same
 * kind, with fresh progress and without the reference images.
 */
export async function startBlock(tenantId: string, actor: Actor, input: unknown): Promise<{ day: DayProtocolSelect; block: BlockSelect }> {
  const data = v.parse(startBlockSchema, input);
  const cell = await getCell(tenantId, data.cellId);
  if (!cell.active) throw new InvalidInputError(`Cell "${cell.name}" is inactive`);
  const skill = await getSkillRow(tenantId, data.skillId);
  if (data.policyId) {
    if (data.kind !== "evaluation") throw new InvalidInputError("Only an evaluation block tests a policy");
    const policy = await getPolicyRow(tenantId, data.policyId);
    if (policy.skillId !== skill.id) throw new InvalidInputError("The policy does not belong to this skill");
  }
  const date = data.date ?? isoDate(new Date());
  const day = await ensureDay(tenantId, actor, cell.id, date);
  const previous = await lastBlockOf(skill.id, data.kind);
  const [block] = await getDb()
    .insert(blocks)
    .values({
      tenantId,
      dayProtocolId: day.id,
      skillId: skill.id,
      kind: data.kind,
      policyId: data.policyId,
      sceneText: previous?.sceneText ?? "",
      targetEpisodes: previous?.targetEpisodes ?? null,
      plan: previous?.plan ? { ...withoutVariationImages(previous.plan), createdAt: new Date().toISOString() } : null,
      createdBy: actor.userId,
    })
    .returning();
  await recordAudit(tenantId, refsOf(block!), actor, "block.started", {
    kind: data.kind,
    cell: cell.name,
    skill: skill.name,
    date,
    policyId: data.policyId,
    continuedFrom: previous?.id ?? null,
  });
  return { day, block: block! };
}

// ---------------------------------------------------------------------------
// Brief
// ---------------------------------------------------------------------------

export const briefSchema = v.object({
  sceneText: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(8000))),
  targetEpisodes: v.optional(v.nullable(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(100000)))),
  /** the kind can still change while the block has neither a plan nor a dataset */
  kind: v.optional(v.picklist(BLOCK_KINDS)),
  policyId: v.optional(v.nullable(v.pipe(v.string(), v.uuid()))),
});

export async function updateBrief(tenantId: string, actor: Actor, id: string, input: unknown): Promise<BlockView> {
  const data = v.parse(briefSchema, input);
  const row = await getBlockRow(tenantId, id);
  const patch: Partial<BlockSelect> = { updatedAt: new Date().toISOString() };
  if (data.sceneText !== undefined) patch.sceneText = data.sceneText;
  if (data.targetEpisodes !== undefined) patch.targetEpisodes = data.targetEpisodes;
  if (data.kind !== undefined && data.kind !== row.kind) {
    const ds = await getDb().select({ id: datasets.id }).from(datasets).where(eq(datasets.blockId, id)).limit(1);
    if (row.plan || ds[0]) throw new ConflictError("The kind of a block can only change while it has neither a plan nor a dataset");
    patch.kind = data.kind;
    if (data.kind === "recording") patch.policyId = null;
  }
  if (data.policyId !== undefined) {
    if (data.policyId) {
      if ((patch.kind ?? row.kind) !== "evaluation") throw new InvalidInputError("Only an evaluation block tests a policy");
      const policy = await getPolicyRow(tenantId, data.policyId);
      if (policy.skillId !== row.skillId) throw new InvalidInputError("The policy does not belong to this skill");
    }
    patch.policyId = data.policyId;
  }
  const [updated] = await getDb().update(blocks).set(patch).where(eq(blocks.id, id)).returning();
  await recordAudit(tenantId, refsOf(row), actor, "block.brief.updated", data);
  return toBlockView(updated!);
}

/**
 * Copy the inputs of another skill once: its task description (when this
 * skill has none), and the scene text, target and plan of its newest recording
 * block.
 */
export async function importFromSkill(tenantId: string, actor: Actor, id: string, sourceSkillId: string): Promise<BlockView> {
  const row = await getBlockRow(tenantId, id);
  const source = await getSkillRow(tenantId, sourceSkillId);
  const last = await lastBlockOf(source.id, row.kind);
  if (!last) throw new InvalidInputError("The source skill has no block of this kind to import from");
  const skill = await getSkillRow(tenantId, row.skillId);
  if (source.taskDescription && !skill.taskDescription) {
    await getDb().update(skills).set({ taskDescription: source.taskDescription, updatedAt: new Date().toISOString() }).where(eq(skills.id, row.skillId));
  }
  const [updated] = await getDb()
    .update(blocks)
    .set({
      sceneText: last.sceneText || row.sceneText,
      targetEpisodes: last.targetEpisodes ?? row.targetEpisodes,
      plan: last.plan ? { ...withoutVariationImages(last.plan), source: "manual", createdAt: new Date().toISOString() } : row.plan,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(blocks.id, id))
    .returning();
  await recordAudit(tenantId, refsOf(row), actor, "block.imported", { sourceSkillId, sourceBlockId: last.id });
  return toBlockView(updated!);
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

export const stepSchema = v.object({ step: v.picklist(BLOCK_STEPS) });

/**
 * Move the wizard. Any step may be revisited; "closed" goes through
 * `closeBlock`, and "recording" through `startRecording`, which opens the
 * window. Leaving the recording step closes that window: the window is "the
 * recording step is open", so stepping back to the plan must not keep the
 * clock running. An evaluation has no selection step: its rollouts are not
 * training material.
 */
export async function setStep(tenantId: string, actor: Actor, id: string, step: BlockStep): Promise<BlockView> {
  const row = await getBlockRow(tenantId, id);
  if (step === "closed") return closeBlock(tenantId, actor, id);
  if (step === "recording") return startRecording(tenantId, actor, id);
  if (step === "selection" && row.kind === "evaluation") throw new ConflictError("An evaluation has no episode selection");
  const now = new Date().toISOString();
  const patch: Partial<BlockSelect> = { step, updatedAt: now };
  if (row.teleopIntervals?.some((i) => !i.endedAt)) {
    patch.teleopIntervals = closeIntervals(row.teleopIntervals, now);
    patch.teleopEndedAt = now;
  }
  if (row.step === "closed") patch.closedAt = null;
  const [updated] = await getDb().update(blocks).set(patch).where(eq(blocks.id, id)).returning();
  await recordAudit(tenantId, refsOf(row), actor, "block.step", { from: row.step, to: step });
  return toBlockView(updated!);
}

/** Close the block row: the open window closes with it, the mobile token dies. */
export async function closeBlockRow(row: BlockSelect, actor: Actor): Promise<BlockSelect> {
  const now = new Date().toISOString();
  const teleopIntervals = closeIntervals(row.teleopIntervals ?? [], now);
  const [updated] = await getDb()
    .update(blocks)
    .set({
      step: "closed",
      closedAt: now,
      teleopIntervals,
      teleopEndedAt: row.teleopStartedAt ? (row.teleopEndedAt ?? now) : row.teleopEndedAt,
      accessToken: null,
      accessTokenExpiresAt: null,
      updatedAt: now,
    })
    .where(eq(blocks.id, row.id))
    .returning();
  await recordAudit(row.tenantId, refsOf(row), actor, "block.closed", { kind: row.kind, teleopMinutes: Math.round(teleopMinutesOf(updated!)) });
  return updated!;
}

/**
 * Close the block. An open window is closed with it, so a block that was
 * left in the recording step does not count time forever.
 */
export async function closeBlock(tenantId: string, actor: Actor, id: string): Promise<BlockView> {
  const row = await getBlockRow(tenantId, id);
  return toBlockView(await closeBlockRow(row, actor));
}

/**
 * The bytes a block owns: its scene photo, the reference images of its plan
 * and the chunks of an upload that was still running. Never fails the caller;
 * a block that cannot be emptied is still deleted.
 */
export async function deleteBlockFiles(row: BlockSelect): Promise<void> {
  if (row.sceneImageRef) await removeFile(row.tenantId, SCENE_IMAGE_BUCKET, row.sceneImageRef).catch(() => undefined);
  await deleteVariationImageFiles(row.tenantId, planImageRefs(row.plan));
  // the chunk rows go with the block through the cascade, so their bytes have
  // to go first, while the rows still say where they are
  const chunks = await getDb()
    .select({ storageRef: datasetUploadChunks.storageRef })
    .from(datasetUploadChunks)
    .innerJoin(datasetUploads, eq(datasetUploadChunks.uploadId, datasetUploads.id))
    .where(eq(datasetUploads.blockId, row.id));
  for (const chunk of chunks) await removeFile(row.tenantId, UPLOAD_CHUNK_BUCKET, chunk.storageRef).catch(() => undefined);
}

/**
 * Delete one block: its datasets go with it (the critics drop their jobs), so
 * do its episodes and images. The day protocol stays, even when this was its
 * only block: the day is the cell's record.
 */
export async function deleteBlock(tenantId: string, actor: Actor, id: string): Promise<void> {
  const row = await getBlockRow(tenantId, id);
  const dsRows = await getDb()
    .select({ id: datasets.id, name: datasets.name, criticsJobId: datasets.criticsJobId })
    .from(datasets)
    .where(eq(datasets.blockId, id));
  await deleteBlockFiles(row);
  // datasets and episodes cascade with the row; the audit rows lose the block and keep skill and day
  await getDb().delete(blocks).where(eq(blocks.id, id));
  for (const ds of dsRows) if (ds.criticsJobId) await criticsClient.deleteJob(ds.criticsJobId);
  await recordAudit(tenantId, { skillId: row.skillId, dayProtocolId: row.dayProtocolId }, actor, "block.deleted", { kind: row.kind, step: row.step, datasets: dsRows.map((d) => d.name) });
}

// ---------------------------------------------------------------------------
// Mobile access token
// ---------------------------------------------------------------------------

export interface AccessTokenInfo {
  token: string;
  expiresAt: string;
}

/** The current mobile token of the block; a new one when missing or expired. */
export async function ensureAccessToken(tenantId: string, id: string): Promise<AccessTokenInfo> {
  const row = await getBlockRow(tenantId, id);
  if (row.step === "closed") throw new ConflictError("The block is closed");
  const valid = row.accessToken && row.accessTokenExpiresAt && new Date(row.accessTokenExpiresAt).getTime() > Date.now();
  if (valid) return { token: row.accessToken!, expiresAt: row.accessTokenExpiresAt! };
  const token = newAccessToken();
  const expiresAt = new Date(Date.now() + ACCESS_TOKEN_TTL_MS).toISOString();
  await getDb().update(blocks).set({ accessToken: token, accessTokenExpiresAt: expiresAt, updatedAt: new Date().toISOString() }).where(eq(blocks.id, id));
  return { token, expiresAt };
}

/** The block behind a mobile token. Throws `TokenError` when unknown or expired. */
export async function resolveAccessToken(token: string): Promise<BlockSelect> {
  if (!token || token.length < 16) throw new TokenError();
  const rows = await getDb().select().from(blocks).where(eq(blocks.accessToken, token)).limit(1);
  const row = rows[0];
  if (!row || !row.accessTokenExpiresAt || new Date(row.accessTokenExpiresAt).getTime() < Date.now() || row.step === "closed") {
    throw new TokenError();
  }
  return row;
}

/** What the mobile views need to render. */
export interface MobileState {
  blockId: string;
  kind: BlockKind;
  date: string;
  cellName: string;
  skillName: string;
  operatorName: string;
  step: BlockStep;
  sceneText: string;
  hasSceneImage: boolean;
  sceneCapturedAt: string | null;
  targetEpisodes: number | null;
  plan: RecordingPlan | null;
  progress: RecordingProgress | null;
}

export async function mobileState(row: BlockSelect): Promise<MobileState> {
  const day = (await getDb().select().from(dayProtocols).where(eq(dayProtocols.id, row.dayProtocolId)).limit(1))[0];
  const cell = day ? (await getDb().select({ name: cells.name }).from(cells).where(eq(cells.id, day.cellId)).limit(1))[0] : undefined;
  const skill = (await getDb().select({ name: skills.name }).from(skills).where(eq(skills.id, row.skillId)).limit(1))[0];
  return {
    blockId: row.id,
    kind: row.kind,
    date: day?.date ?? "",
    cellName: cell?.name ?? "",
    skillName: skill?.name ?? "",
    operatorName: day?.operatorName ?? "",
    step: row.step,
    sceneText: row.sceneText,
    hasSceneImage: !!row.sceneImageRef,
    sceneCapturedAt: utcIso(row.sceneCapturedAt),
    targetEpisodes: row.targetEpisodes,
    plan: row.plan,
    progress: row.progress,
  };
}

// ---------------------------------------------------------------------------
// Scene photo and text
// ---------------------------------------------------------------------------

const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"]);
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;

/** Store the scene photo (replacing an earlier one). Works for both the signed-in and the mobile path. */
export async function setSceneImage(row: BlockSelect, file: File, actor: Actor = SYSTEM_ACTOR): Promise<BlockSelect> {
  if (!IMAGE_TYPES.has(file.type)) throw new InvalidInputError("Only JPEG, PNG, WebP or HEIC images are accepted");
  if (file.size > MAX_IMAGE_BYTES) throw new InvalidInputError("The image is larger than 15 MB");
  const saved = await putFile(row.tenantId, SCENE_IMAGE_BUCKET, file);
  if (row.sceneImageRef) {
    await removeFile(row.tenantId, SCENE_IMAGE_BUCKET, row.sceneImageRef).catch(() => undefined);
  }
  const [updated] = await getDb()
    .update(blocks)
    .set({ sceneImageRef: saved.ref, updatedAt: new Date().toISOString() })
    .where(eq(blocks.id, row.id))
    .returning();
  await recordAudit(row.tenantId, refsOf(row), actor, "block.scene.image", { bytes: file.size, type: file.type });
  return updated!;
}

export async function removeSceneImage(tenantId: string, actor: Actor, id: string): Promise<BlockView> {
  const row = await getBlockRow(tenantId, id);
  if (row.sceneImageRef) await removeFile(tenantId, SCENE_IMAGE_BUCKET, row.sceneImageRef).catch(() => undefined);
  const [updated] = await getDb()
    .update(blocks)
    .set({ sceneImageRef: null, updatedAt: new Date().toISOString() })
    .where(eq(blocks.id, id))
    .returning();
  await recordAudit(tenantId, refsOf(row), actor, "block.scene.image.removed", {});
  return toBlockView(updated!);
}

export async function getSceneImage(row: BlockSelect): Promise<File | null> {
  if (!row.sceneImageRef) return null;
  return readFile(row.tenantId, SCENE_IMAGE_BUCKET, row.sceneImageRef);
}

export async function setSceneText(row: BlockSelect, text: string, actor: Actor = SYSTEM_ACTOR): Promise<BlockSelect> {
  const [updated] = await getDb()
    .update(blocks)
    .set({ sceneText: text.trim().slice(0, 8000), updatedAt: new Date().toISOString() })
    .where(eq(blocks.id, row.id))
    .returning();
  await recordAudit(row.tenantId, refsOf(row), actor, "block.scene.text", { length: text.trim().length });
  return updated!;
}

/** The mobile view is done: the operator view picks this up and shows the result. */
export async function markSceneCaptured(row: BlockSelect): Promise<BlockSelect> {
  const now = new Date().toISOString();
  const [updated] = await getDb()
    .update(blocks)
    .set({ sceneCapturedAt: now, updatedAt: now })
    .where(eq(blocks.id, row.id))
    .returning();
  await recordAudit(row.tenantId, refsOf(row), SYSTEM_ACTOR, "block.scene.captured", {});
  return updated!;
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

/** The variation labels of the skill's recording blocks, for an evaluation plan to cover. */
async function recordedVariationsOf(skillId: string): Promise<string[]> {
  const rows = await getDb()
    .select({ plan: blocks.plan })
    .from(blocks)
    .where(and(eq(blocks.skillId, skillId), eq(blocks.kind, "recording")))
    .orderBy(desc(blocks.createdAt))
    .limit(20);
  const labels = new Set<string>();
  for (const r of rows) for (const s of r.plan?.steps ?? []) for (const x of s.variations) if (x.label) labels.add(x.label);
  return [...labels];
}

async function planInputOf(row: BlockSelect, skill: SkillSelect, language: Language, targetEpisodes: number) {
  const day = await getDayRow(row.tenantId, row.dayProtocolId);
  const cell = (await getDb().select().from(cells).where(eq(cells.id, day.cellId)).limit(1))[0]!;
  const image = await getSceneImage(row);
  const policy = row.policyId ? await getPolicyRow(row.tenantId, row.policyId).catch(() => null) : null;
  return {
    cellName: cell.name,
    kind: row.kind,
    policyName: policy?.name ?? null,
    recordedVariations: row.kind === "evaluation" ? await recordedVariationsOf(row.skillId) : [],
    taskDescription: skill.taskDescription,
    sceneText: row.sceneText,
    targetEpisodes,
    image: image ? { data: new Uint8Array(await image.arrayBuffer()), mediaType: image.type || "image/jpeg" } : null,
    language,
  };
}

/** Ask the AI for a plan from the brief. Moves the wizard to "plan". */
export async function generatePlan(tenantId: string, actor: Actor, id: string, language: Language): Promise<BlockView> {
  const row = await getBlockRow(tenantId, id);
  if (!row.targetEpisodes) throw new InvalidInputError("Set the target number of episodes first");
  const skill = await getSkillRow(tenantId, row.skillId);
  const plan = await proposeRecordingPlan(await planInputOf(row, skill, language, row.targetEpisodes));
  const [updated] = await getDb()
    .update(blocks)
    .set({ plan, progress: null, step: "plan", updatedAt: new Date().toISOString() })
    .where(eq(blocks.id, id))
    .returning();
  await deleteVariationImageFiles(tenantId, planImageRefs(row.plan));
  await recordAudit(tenantId, refsOf(row), actor, "block.plan.generated", { kind: row.kind, source: plan.source, steps: plan.steps.length, episodes: plan.steps.reduce((a, s) => a + s.episodes, 0) });
  return toBlockView(updated!);
}

export const planInputSchema = v.object({
  summary: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(2000)), ""),
  sceneSetup: v.optional(v.array(v.pipe(v.string(), v.trim(), v.maxLength(500))), []),
  randomizations: v.optional(v.array(v.pipe(v.string(), v.trim(), v.maxLength(500))), []),
  steps: v.pipe(
    v.array(
      v.object({
        id: v.optional(v.string()),
        title: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(300)),
        instructions: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(4000)), ""),
        variations: v.array(
          v.object({
            label: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(300)),
            episodes: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(100000)),
            imagePrompt: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(2000)), ""),
            /**
             * Which reference image this variation keeps. Only the storage
             * reference travels: the record itself is taken from the stored
             * plan, so a client can keep or drop an image but never invent one.
             */
            image: v.optional(v.nullable(v.object({ ref: v.pipe(v.string(), v.minLength(1), v.maxLength(400)) }))),
          }),
        ),
      }),
    ),
    v.minLength(1, "A plan needs at least one step"),
  ),
});

/** The operator's edited plan. Progress is kept for steps that survive. */
export async function updatePlan(tenantId: string, actor: Actor, id: string, input: unknown): Promise<BlockView> {
  const data = v.parse(planInputSchema, input);
  const row = await getBlockRow(tenantId, id);
  // the images of the stored plan, by storage reference: only these may be kept
  const known = new Map<string, PlanVariationImage>();
  for (const ref of planImageRefs(row.plan)) {
    const image = row.plan?.steps.flatMap((s) => s.variations).find((x) => x.image?.ref === ref)?.image;
    if (image) known.set(ref, image);
  }
  const plan: RecordingPlan = {
    summary: data.summary,
    sceneSetup: data.sceneSetup.filter(Boolean),
    randomizations: data.randomizations.filter(Boolean),
    steps: data.steps.map((s) => ({
      id: s.id || newStepId(),
      title: s.title,
      instructions: s.instructions,
      variations: s.variations.map((x) => ({
        label: x.label,
        episodes: x.episodes,
        imagePrompt: x.imagePrompt,
        image: (x.image && known.get(x.image.ref)) ?? null,
      })),
      episodes: s.variations.reduce((a, x) => a + x.episodes, 0),
    })),
    source: "manual",
    createdAt: row.plan?.createdAt ?? new Date().toISOString(),
  };
  const kept = new Set(planImageRefs(plan));
  const ids = new Set(plan.steps.map((s) => s.id));
  const progress = row.progress
    ? {
        ...row.progress,
        completed: Object.fromEntries(Object.entries(row.progress.completed).filter(([k]) => ids.has(k))),
        currentStepId: row.progress.currentStepId && ids.has(row.progress.currentStepId) ? row.progress.currentStepId : (plan.steps[0]?.id ?? null),
      }
    : null;
  const [updated] = await getDb()
    .update(blocks)
    .set({ plan, progress, updatedAt: new Date().toISOString() })
    .where(eq(blocks.id, id))
    .returning();
  await deleteVariationImageFiles(tenantId, planImageRefs(row.plan).filter((ref) => !kept.has(ref)));
  await recordAudit(tenantId, refsOf(row), actor, "block.plan.updated", { steps: plan.steps.length });
  return toBlockView(updated!);
}

// ---------------------------------------------------------------------------
// Reference images of the plan's variations
// ---------------------------------------------------------------------------

/**
 * Every variation of the plan may carry one picture of the scene as it should
 * look when the variation is built up. The picture is optional in every
 * respect: it is generated from the block's scene photo by the image model,
 * or uploaded, or taken over from the scene photo, and it can be replaced or
 * removed at any time. Nothing in the wizard depends on it.
 *
 * A variation is addressed by its step id and its index inside the step, the
 * same identity the operator sees in the plan editor.
 */

/** The storage references of all reference images of a plan. */
export const planImageRefs = (plan: RecordingPlan | null | undefined): string[] =>
  plan?.steps.flatMap((s) => s.variations.map((x) => x.image?.ref).filter((ref): ref is string => !!ref)) ?? [];

/** Drop image files nobody points at any more. Never fails the caller. */
async function deleteVariationImageFiles(tenantId: string, refs: string[]): Promise<void> {
  for (const ref of refs) {
    await removeFile(tenantId, VARIATION_IMAGE_BUCKET, ref).catch(() => undefined);
  }
}

/** A plan copied to another block keeps the prompts but not the image files of the original. */
export const withoutVariationImages = (plan: RecordingPlan): RecordingPlan => ({
  ...plan,
  steps: plan.steps.map((s) => ({ ...s, variations: s.variations.map((x) => ({ ...x, image: null })) })),
});

function locateVariation(plan: RecordingPlan | null, stepId: string, index: number): { step: PlanStep; variation: PlanVariation } {
  if (!plan) throw new ConflictError("Create a plan before working on its images");
  const step = plan.steps.find((s) => s.id === stepId);
  if (!step) throw new NotFoundError("Plan step");
  const variation = step.variations[index];
  if (!variation) throw new NotFoundError("Plan variation");
  return { step, variation };
}

/** Write the image record of one variation into the plan and drop the file it replaces. */
async function writeVariationImage(row: BlockSelect, stepId: string, index: number, image: PlanVariationImage | null): Promise<BlockSelect> {
  const plan = row.plan!;
  const previous = locateVariation(plan, stepId, index).variation.image?.ref ?? null;
  const next: RecordingPlan = {
    ...plan,
    steps: plan.steps.map((s) => (s.id === stepId ? { ...s, variations: s.variations.map((x, i) => (i === index ? { ...x, image } : x)) } : s)),
  };
  const [updated] = await getDb()
    .update(blocks)
    .set({ plan: next, updatedAt: new Date().toISOString() })
    .where(eq(blocks.id, row.id))
    .returning();
  // a duplicated step shares its pictures with the original: the file goes only when nobody points at it any more
  if (previous && !planImageRefs(next).includes(previous)) await deleteVariationImageFiles(row.tenantId, [previous]);
  return updated!;
}

const imageExtension = (mediaType: string) => (mediaType.includes("png") ? "png" : mediaType.includes("webp") ? "webp" : "jpg");

/** Is the image model available on this instance? */
export const canGenerateVariationImages = (): boolean => isImageGenerationEnabled();

/**
 * Let the image model draw the variation: the scene photo, edited by the
 * variation's prompt. Replaces an image that is already there.
 */
export async function generateVariationImage(tenantId: string, actor: Actor, id: string, stepId: string, index: number): Promise<BlockView> {
  const row = await getBlockRow(tenantId, id);
  if (!isImageGenerationEnabled()) throw new ConflictError("No image model is configured on this instance");
  const { step, variation } = locateVariation(row.plan, stepId, index);
  const scene = await getSceneImage(row);
  if (!scene) throw new InvalidInputError("The block needs a scene photo before images can be generated");
  const prompt = variationImagePrompt(step, variation);
  let generated;
  try {
    generated = await editSceneImage({ data: new Uint8Array(await scene.arrayBuffer()), mediaType: scene.type || "image/jpeg" }, prompt);
  } catch (error) {
    if (error instanceof ImageGenerationError) throw new UpstreamError(error.message);
    throw error;
  }
  const saved = await putFile(
    tenantId,
    VARIATION_IMAGE_BUCKET,
    new File([generated.data], `variation.${imageExtension(generated.mediaType)}`, { type: generated.mediaType }),
  );
  const updated = await writeVariationImage(row, stepId, index, { ref: saved.ref, source: "ai", prompt, createdAt: new Date().toISOString() });
  await recordAudit(tenantId, refsOf(row), actor, "block.plan.image.generated", { stepId, index, model: getGymImageModel() });
  return toBlockView(updated);
}

/** The operator's own picture of the variation. */
export async function setVariationImage(tenantId: string, actor: Actor, id: string, stepId: string, index: number, file: File): Promise<BlockView> {
  if (!IMAGE_TYPES.has(file.type)) throw new InvalidInputError("Only JPEG, PNG, WebP or HEIC images are accepted");
  if (file.size > MAX_IMAGE_BYTES) throw new InvalidInputError("The image is larger than 15 MB");
  const row = await getBlockRow(tenantId, id);
  locateVariation(row.plan, stepId, index);
  const saved = await putFile(tenantId, VARIATION_IMAGE_BUCKET, file);
  const updated = await writeVariationImage(row, stepId, index, { ref: saved.ref, source: "upload", prompt: "", createdAt: new Date().toISOString() });
  await recordAudit(tenantId, refsOf(row), actor, "block.plan.image.uploaded", { stepId, index, bytes: file.size });
  return toBlockView(updated);
}

/** The scene photo as it is: the picture of a variation that changes nothing. */
export async function useSceneImageForVariation(tenantId: string, actor: Actor, id: string, stepId: string, index: number): Promise<BlockView> {
  const row = await getBlockRow(tenantId, id);
  locateVariation(row.plan, stepId, index);
  const scene = await getSceneImage(row);
  if (!scene) throw new InvalidInputError("The block has no scene photo");
  const type = scene.type || "image/jpeg";
  const saved = await putFile(tenantId, VARIATION_IMAGE_BUCKET, new File([await scene.arrayBuffer()], `variation.${imageExtension(type)}`, { type }));
  const updated = await writeVariationImage(row, stepId, index, { ref: saved.ref, source: "scene", prompt: "", createdAt: new Date().toISOString() });
  await recordAudit(tenantId, refsOf(row), actor, "block.plan.image.scene", { stepId, index });
  return toBlockView(updated);
}

export async function removeVariationImage(tenantId: string, actor: Actor, id: string, stepId: string, index: number): Promise<BlockView> {
  const row = await getBlockRow(tenantId, id);
  locateVariation(row.plan, stepId, index);
  const updated = await writeVariationImage(row, stepId, index, null);
  await recordAudit(tenantId, refsOf(row), actor, "block.plan.image.removed", { stepId, index });
  return toBlockView(updated);
}

/** The reference image of a variation, for the operator view and the phone. */
export async function getVariationImage(row: BlockSelect, stepId: string, index: number): Promise<File | null> {
  const ref = locateVariation(row.plan, stepId, index).variation.image?.ref;
  if (!ref) return null;
  return readFile(row.tenantId, VARIATION_IMAGE_BUCKET, ref);
}

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

/**
 * The recording step opens: a new window starts. `teleopStartedAt` stays on
 * the first start of the block, but the time that is counted is the sum of
 * the windows, so a block that is opened and closed five times counts those
 * five stretches and not the breaks between them. Entering the step again
 * while a window is open changes nothing.
 *
 * A block may start without a plan: with `withoutPlan` the operator says so,
 * and the block runs on a plain plan, the target number of episodes on the
 * task of the skill or the scene, with nothing else claimed. It needs that
 * description: without one there is nothing to record against. An evaluation
 * that reaches the step without a plan gets the deterministic proposal over
 * the settings the skill was recorded with.
 */
export async function startRecording(tenantId: string, actor: Actor, id: string, options: { withoutPlan?: boolean } = {}): Promise<BlockView> {
  const row = await getBlockRow(tenantId, id);
  let plan = row.plan;
  if (!plan) {
    if (!options.withoutPlan && row.kind !== "evaluation") throw new ConflictError("Create a plan before recording");
    if (options.withoutPlan && !row.targetEpisodes) throw new InvalidInputError("Set the target number of episodes first");
    const skill = await getSkillRow(tenantId, row.skillId);
    const input = await planInputOf(row, skill, "de", row.targetEpisodes ?? 10);
    if (options.withoutPlan && !input.taskDescription.trim() && !input.sceneText.trim()) {
      throw new InvalidInputError("Describe the task before starting without a plan");
    }
    plan = options.withoutPlan ? plainPlan(input) : fallbackPlan(input);
    await recordAudit(tenantId, refsOf(row), actor, "block.plan.generated", { kind: row.kind, source: plan.source, steps: plan.steps.length, episodes: plan.steps.reduce((a, s) => a + s.episodes, 0), implicit: true });
  }
  const now = new Date().toISOString();
  const progress: RecordingProgress = row.progress ?? { completed: {}, currentStepId: plan.steps[0]?.id ?? null, updatedAt: now };
  const teleopIntervals = openInterval(row.teleopIntervals ?? [], now);
  const [updated] = await getDb()
    .update(blocks)
    .set({ step: "recording", plan, teleopStartedAt: row.teleopStartedAt ?? now, teleopIntervals, progress, updatedAt: now })
    .where(eq(blocks.id, id))
    .returning();
  await recordAudit(tenantId, refsOf(row), actor, "block.recording.started", { kind: row.kind, firstStart: !row.teleopStartedAt, window: teleopIntervals.length });
  return toBlockView(updated!);
}

export const progressSchema = v.object({
  stepId: v.string(),
  /** +1 after a recording, -1 to undo */
  delta: v.pipe(v.number(), v.integer(), v.minValue(-1000), v.maxValue(1000)),
});

/** One more (or one less) episode recorded for a plan step. Used by the recording run view. */
export async function recordProgress(row: BlockSelect, stepId: string, delta: number, actor: Actor = SYSTEM_ACTOR): Promise<BlockSelect> {
  if (!row.plan) throw new ConflictError("The block has no plan");
  const step = row.plan.steps.find((s) => s.id === stepId);
  if (!step) throw new InvalidInputError("Unknown plan step");
  const completed = { ...(row.progress?.completed ?? {}) };
  completed[stepId] = Math.max(0, (completed[stepId] ?? 0) + delta);
  // move on when the step is complete
  const idx = row.plan.steps.findIndex((s) => s.id === stepId);
  const next = completed[stepId]! >= step.episodes ? (row.plan.steps[idx + 1]?.id ?? stepId) : stepId;
  const progress: RecordingProgress = { completed, currentStepId: next, updatedAt: new Date().toISOString() };
  const [updated] = await getDb()
    .update(blocks)
    .set({ progress, updatedAt: progress.updatedAt })
    .where(eq(blocks.id, row.id))
    .returning();
  if (delta > 0 && completed[stepId] === step.episodes) {
    await recordAudit(row.tenantId, refsOf(row), actor, "block.recording.step.completed", { step: step.title, episodes: step.episodes });
  }
  return updated!;
}

export const currentStepSchema = v.object({ stepId: v.string() });

/**
 * The operator picks the step to work on next, by hand: the plan is worked in
 * order unless somebody says otherwise, and "next" counts on the chosen step
 * from here on. Used by the recording step and the run view.
 */
export async function setCurrentStep(row: BlockSelect, stepId: string): Promise<BlockSelect> {
  if (!row.plan) throw new ConflictError("The block has no plan");
  if (!row.plan.steps.some((s) => s.id === stepId)) throw new InvalidInputError("Unknown plan step");
  const now = new Date().toISOString();
  const progress: RecordingProgress = { completed: { ...(row.progress?.completed ?? {}) }, currentStepId: stepId, updatedAt: now };
  const [updated] = await getDb()
    .update(blocks)
    .set({ progress, updatedAt: now })
    .where(eq(blocks.id, row.id))
    .returning();
  return updated!;
}

/** Recording is done for now: the open window closes, on to the upload. */
export async function finishRecording(tenantId: string, actor: Actor, id: string): Promise<BlockView> {
  const row = await getBlockRow(tenantId, id);
  const now = new Date().toISOString();
  const teleopIntervals = closeIntervals(row.teleopIntervals ?? [], now);
  const [updated] = await getDb()
    .update(blocks)
    .set({ step: "upload", teleopEndedAt: now, teleopIntervals, updatedAt: now })
    .where(eq(blocks.id, id))
    .returning();
  const done = Object.values(row.progress?.completed ?? {}).reduce((a, b) => a + b, 0);
  await recordAudit(tenantId, refsOf(row), actor, "block.recording.finished", { episodesCounted: done, teleopMinutes: Math.round(teleopMinutesOf(updated!)) });
  return toBlockView(updated!);
}

// ---------------------------------------------------------------------------
// Follow-up advice
// ---------------------------------------------------------------------------

export async function suggestFollowUp(tenantId: string, actor: Actor, id: string, language: Language): Promise<BlockView> {
  const row = await getBlockRow(tenantId, id);
  await syncOpenDatasets([id]);
  const ds = await getDb()
    .select({ analysis: datasets.analysis, criticsJobId: datasets.criticsJobId })
    .from(datasets)
    .where(and(eq(datasets.blockId, id), eq(datasets.analysisStatus, "done")));
  const analyses = ds.map((d) => d.analysis).filter((a): a is CriticsSummary => !!a);
  if (!analyses.length) throw new ConflictError("Upload a dataset and wait for the critics first");
  // the critics' own Markdown report is the best input for the advice; skipped when the service is away
  const reports: string[] = [];
  for (const d of ds) {
    if (!d.criticsJobId) continue;
    const text = await criticsClient.markdown(d.criticsJobId, "summary").catch(() => null);
    if (text) reports.push(text);
  }
  const followUp = await proposeFollowUp({ language, targetEpisodes: row.targetEpisodes, plan: row.plan, analyses, reports });
  const [updated] = await getDb()
    .update(blocks)
    .set({ followUp, updatedAt: new Date().toISOString() })
    .where(eq(blocks.id, id))
    .returning();
  await recordAudit(tenantId, refsOf(row), actor, "block.followup.generated", { source: followUp.source, items: followUp.items.length });
  return toBlockView(updated!);
}
