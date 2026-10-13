/**
 * Day protocols: one per cell and day, the controlling record of the cell.
 *
 * A day protocol says who worked in the cell, how long it stood still and
 * what else was noteworthy, and it is the printable, shareable view of the
 * day. The work itself is done in its blocks (lib/gym/blocks.ts): recording
 * blocks and evaluation blocks, each for one skill. A day is created with its
 * first block and can be closed by hand; closing it closes its open blocks.
 */
import { and, asc, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import * as v from "valibot";
import { getDb } from "@framework/lib/db/db-connection";
import { blocks, cells, datasets, dayProtocols, type BlockKind, type BlockStep, type DatasetAnalysisStatus, type DayProtocolSelect, type DowntimeEvent } from "../../db/schema";
import { criticsClient } from "../critics/client";
import { recordAudit, type Actor } from "./audit";
import { closeBlockRow, deleteBlockFiles, toBlockViews, type BlockView, type EpisodeTotals } from "./blocks";
import { NotFoundError } from "./errors";
import { downtimeMinutes, isTeleopRunning, teleopMinutes } from "./teleop";
import { newShareId } from "./tokens";
import { utcRow } from "./time";

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

/**
 * The times of a day, summed over its blocks and kept apart by what they
 * measure: teleoperation minutes (recording blocks), evaluation minutes
 * (evaluation blocks), the recorded seconds from the uploads of the recording
 * blocks, and the downtime the operator wrote down for the day.
 */
export interface DayTimes {
  teleopMinutes: number;
  evaluationMinutes: number;
  /** a window of one of the blocks is open right now */
  teleopRunning: boolean;
  recordedSeconds: number | null;
  downtimeMinutes: number;
}

/** A day protocol as the API returns it: with its cell, its blocks and the sums over them. */
export type DayView = DayProtocolSelect & {
  cell: { id: string; name: string; location: string };
  blocks: BlockView[];
  /** episodes of the recording blocks */
  totals: EpisodeTotals;
  /** rollouts of the evaluation blocks */
  evaluation: { blocks: number; episodes: number; accepted: number };
  times: DayTimes;
  /** true while a block of the day is not closed */
  open: boolean;
};

const NO_EPISODES: EpisodeTotals = { episodes: 0, accepted: 0, review: 0, rejected: 0, selected: 0, recordedSeconds: null };

export async function toDayView(row: DayProtocolSelect): Promise<DayView> {
  const views = await toDayViews([row]);
  return views[0]!;
}

export async function toDayViews(rows: DayProtocolSelect[]): Promise<DayView[]> {
  if (!rows.length) return [];
  const cellRows = await getDb().select().from(cells).where(inArray(cells.id, [...new Set(rows.map((r) => r.cellId))]));
  const cellById = new Map(cellRows.map((c) => [c.id, c]));
  const blockRows = await getDb()
    .select()
    .from(blocks)
    .where(inArray(blocks.dayProtocolId, rows.map((r) => r.id)))
    .orderBy(asc(blocks.createdAt));
  const blockViews = await toBlockViews(blockRows);
  const byDay = new Map<string, BlockView[]>();
  for (const b of blockViews) byDay.set(b.dayProtocolId, [...(byDay.get(b.dayProtocolId) ?? []), b]);
  const now = Date.now();
  return rows.map((row) => {
    const cell = cellById.get(row.cellId);
    const dayBlocks = byDay.get(row.id) ?? [];
    const recording = dayBlocks.filter((b) => b.kind === "recording");
    const evaluation = dayBlocks.filter((b) => b.kind === "evaluation");
    const totals = recording.reduce<EpisodeTotals>(
      (t, b) => ({
        episodes: t.episodes + b.totals.episodes,
        accepted: t.accepted + b.totals.accepted,
        review: t.review + b.totals.review,
        rejected: t.rejected + b.totals.rejected,
        selected: t.selected + b.totals.selected,
        recordedSeconds: b.totals.recordedSeconds == null ? t.recordedSeconds : (t.recordedSeconds ?? 0) + b.totals.recordedSeconds,
      }),
      { ...NO_EPISODES },
    );
    return {
      ...utcRow(row),
      cell: { id: row.cellId, name: cell?.name ?? "", location: cell?.location ?? "" },
      blocks: dayBlocks,
      totals,
      evaluation: {
        blocks: evaluation.length,
        episodes: evaluation.reduce((a, b) => a + b.totals.episodes, 0),
        accepted: evaluation.reduce((a, b) => a + b.totals.accepted, 0),
      },
      times: {
        teleopMinutes: Math.round(recording.reduce((a, b) => a + teleopMinutes(b, now), 0)),
        evaluationMinutes: Math.round(evaluation.reduce((a, b) => a + teleopMinutes(b, now), 0)),
        teleopRunning: dayBlocks.some((b) => isTeleopRunning(b.teleopIntervals ?? [])),
        recordedSeconds: totals.recordedSeconds == null ? null : Math.round(totals.recordedSeconds),
        downtimeMinutes: Math.round(downtimeMinutes(row)),
      },
      open: dayBlocks.some((b) => b.step !== "closed"),
    };
  });
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export async function getDayRow(tenantId: string, id: string): Promise<DayProtocolSelect> {
  const rows = await getDb()
    .select()
    .from(dayProtocols)
    .where(and(eq(dayProtocols.id, id), eq(dayProtocols.tenantId, tenantId)))
    .limit(1);
  if (!rows[0]) throw new NotFoundError("Day protocol");
  return rows[0];
}

export const getDay = async (tenantId: string, id: string): Promise<DayView> => toDayView(await getDayRow(tenantId, id));

export async function findDayByCellAndDate(tenantId: string, cellId: string, date: string): Promise<DayProtocolSelect | null> {
  const rows = await getDb()
    .select()
    .from(dayProtocols)
    .where(and(eq(dayProtocols.tenantId, tenantId), eq(dayProtocols.cellId, cellId), eq(dayProtocols.date, date)))
    .limit(1);
  return rows[0] ?? null;
}

export interface DayFilter {
  from?: string;
  to?: string;
  cellId?: string;
  /** days with at least one block of this skill */
  skillId?: string;
  limit?: number;
}

/** Day protocols, newest first. */
export async function listDays(tenantId: string, filter: DayFilter = {}): Promise<DayView[]> {
  const conditions = [eq(dayProtocols.tenantId, tenantId)];
  if (filter.from) conditions.push(gte(dayProtocols.date, filter.from));
  if (filter.to) conditions.push(lte(dayProtocols.date, filter.to));
  if (filter.cellId) conditions.push(eq(dayProtocols.cellId, filter.cellId));
  if (filter.skillId) {
    conditions.push(sql`exists (select 1 from ${blocks} where ${blocks.dayProtocolId} = ${dayProtocols.id} and ${blocks.skillId} = ${filter.skillId})`);
  }
  const rows = await getDb()
    .select()
    .from(dayProtocols)
    .where(and(...conditions))
    .orderBy(desc(dayProtocols.date), desc(dayProtocols.createdAt))
    .limit(filter.limit ?? 500);
  return toDayViews(rows);
}

// ---------------------------------------------------------------------------
// Create, update, close, delete
// ---------------------------------------------------------------------------

/**
 * The day protocol of a cell and date: the existing one, reopened when it was
 * closed, else a new one with the acting user as operator. Called when a
 * block is started (lib/gym/blocks.ts).
 */
export async function ensureDay(tenantId: string, actor: Actor, cellId: string, date: string): Promise<DayProtocolSelect> {
  const existing = await findDayByCellAndDate(tenantId, cellId, date);
  if (existing) {
    if (!existing.closedAt) return existing;
    const [reopened] = await getDb()
      .update(dayProtocols)
      .set({ closedAt: null, updatedAt: new Date().toISOString() })
      .where(eq(dayProtocols.id, existing.id))
      .returning();
    await recordAudit(tenantId, { dayProtocolId: existing.id }, actor, "day.reopened", { date });
    return reopened!;
  }
  const [row] = await getDb()
    .insert(dayProtocols)
    .values({ tenantId, cellId, date, operatorUserId: actor.userId, operatorName: actor.userName, shareId: newShareId() })
    .returning();
  await recordAudit(tenantId, { dayProtocolId: row!.id }, actor, "day.created", { date });
  return row!;
}

export const dayUpdateSchema = v.object({
  notes: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(8000))),
  operatorName: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(200))),
});

export async function updateDay(tenantId: string, actor: Actor, id: string, input: unknown): Promise<DayView> {
  const data = v.parse(dayUpdateSchema, input);
  await getDayRow(tenantId, id);
  const [updated] = await getDb()
    .update(dayProtocols)
    .set({ ...data, updatedAt: new Date().toISOString() })
    .where(eq(dayProtocols.id, id))
    .returning();
  await recordAudit(tenantId, { dayProtocolId: id }, actor, "day.updated", data);
  return toDayView(updated!);
}

/** Close the day: every open block is closed with it, so no window keeps counting. */
export async function closeDay(tenantId: string, actor: Actor, id: string): Promise<DayView> {
  const row = await getDayRow(tenantId, id);
  const open = await getDb()
    .select()
    .from(blocks)
    .where(and(eq(blocks.dayProtocolId, id), sql`${blocks.step} <> 'closed'`));
  for (const b of open) await closeBlockRow(b, actor);
  const now = new Date().toISOString();
  const [updated] = await getDb().update(dayProtocols).set({ closedAt: now, updatedAt: now }).where(eq(dayProtocols.id, id)).returning();
  await recordAudit(tenantId, { dayProtocolId: id }, actor, "day.closed", { date: row.date, blocksClosed: open.length });
  return toDayView(updated!);
}

/**
 * Delete a day protocol with its blocks and their datasets (the critics drop
 * their jobs). The audit rows of the day go with it; those of the skills stay.
 */
export async function deleteDay(tenantId: string, actor: Actor, id: string): Promise<void> {
  const row = await getDayRow(tenantId, id);
  const blockRows = await getDb().select().from(blocks).where(eq(blocks.dayProtocolId, id));
  const dsRows = await getDb()
    .select({ id: datasets.id, name: datasets.name, criticsJobId: datasets.criticsJobId, skillId: datasets.skillId })
    .from(datasets)
    .where(eq(datasets.dayProtocolId, id));
  for (const b of blockRows) await deleteBlockFiles(b);
  for (const skillId of new Set(blockRows.map((b) => b.skillId))) {
    await recordAudit(tenantId, { skillId }, actor, "day.deleted", { date: row.date, datasets: dsRows.filter((d) => d.skillId === skillId).map((d) => d.name) });
  }
  // blocks, datasets and episodes cascade with the row
  await getDb().delete(dayProtocols).where(eq(dayProtocols.id, id));
  for (const ds of dsRows) if (ds.criticsJobId) await criticsClient.deleteJob(ds.criticsJobId);
}

// ---------------------------------------------------------------------------
// Downtime
// ---------------------------------------------------------------------------

export const downtimeSchema = v.object({
  reason: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(500)),
  /** how long the cell stood still */
  minutes: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(24 * 60)),
  /** when it started; defaults to now */
  at: v.optional(v.string()),
});

/**
 * Write down a downtime. Nothing in the tool can observe that the cell stood
 * still, so the operator says it: a reason and a number of minutes. Downtime
 * belongs to the day, not to a block: the cell stood still, whatever was
 * running in it.
 */
export async function addDowntime(tenantId: string, actor: Actor, id: string, input: unknown): Promise<DayView> {
  const data = v.parse(downtimeSchema, input);
  const row = await getDayRow(tenantId, id);
  const now = new Date().toISOString();
  const at = data.at && !Number.isNaN(new Date(data.at).getTime()) ? new Date(data.at).toISOString() : now;
  const event: DowntimeEvent = {
    id: crypto.randomUUID(),
    reason: data.reason,
    minutes: data.minutes,
    at,
    createdBy: actor.userId,
    createdByName: actor.userName,
    createdAt: now,
  };
  const downtime = [...(row.downtime ?? []), event].sort((a, b) => a.at.localeCompare(b.at));
  const [updated] = await getDb().update(dayProtocols).set({ downtime, updatedAt: now }).where(eq(dayProtocols.id, id)).returning();
  await recordAudit(tenantId, { dayProtocolId: id }, actor, "day.downtime.added", { reason: event.reason, minutes: event.minutes });
  return toDayView(updated!);
}

export async function removeDowntime(tenantId: string, actor: Actor, id: string, eventId: string): Promise<DayView> {
  const row = await getDayRow(tenantId, id);
  const event = (row.downtime ?? []).find((d) => d.id === eventId);
  if (!event) throw new NotFoundError("Downtime");
  const downtime = (row.downtime ?? []).filter((d) => d.id !== eventId);
  const now = new Date().toISOString();
  const [updated] = await getDb().update(dayProtocols).set({ downtime, updatedAt: now }).where(eq(dayProtocols.id, id)).returning();
  await recordAudit(tenantId, { dayProtocolId: id }, actor, "day.downtime.removed", { reason: event.reason, minutes: event.minutes });
  return toDayView(updated!);
}

// ---------------------------------------------------------------------------
// Printable view (public by share id)
// ---------------------------------------------------------------------------

export interface PrintBlock {
  id: string;
  kind: BlockKind;
  skill: { name: string; taskDescription: string };
  policyName: string | null;
  step: BlockStep;
  targetEpisodes: number | null;
  sceneText: string;
  hasSceneImage: boolean;
  plan: { summary: string; steps: { title: string; episodes: number }[] } | null;
  teleopStartedAt: string | null;
  teleopEndedAt: string | null;
  minutes: number;
  datasets: { name: string; status: DatasetAnalysisStatus; episodes: number; accepted: number; review: number; rejected: number; medianSeconds: number | null; specName: string | null }[];
  totals: EpisodeTotals;
}

export interface PrintView {
  shareId: string;
  date: string;
  cell: { name: string; location: string };
  operatorName: string;
  blocks: PrintBlock[];
  times: DayTimes;
  downtime: DowntimeEvent[];
  /** episodes of the recording blocks */
  totals: EpisodeTotals;
  evaluation: { blocks: number; episodes: number; accepted: number };
  notes: string;
  closedAt: string | null;
}

export async function getDayByShareId(shareId: string): Promise<DayProtocolSelect> {
  const rows = await getDb().select().from(dayProtocols).where(eq(dayProtocols.shareId, shareId)).limit(1);
  if (!rows[0]) throw new NotFoundError("Day protocol");
  return rows[0];
}

export async function printView(row: DayProtocolSelect): Promise<PrintView> {
  const view = await toDayView(row);
  return {
    shareId: row.shareId,
    date: row.date,
    cell: { name: view.cell.name, location: view.cell.location },
    operatorName: row.operatorName,
    blocks: view.blocks.map((b) => ({
      id: b.id,
      kind: b.kind,
      skill: { name: b.skill.name, taskDescription: b.skill.taskDescription },
      policyName: b.policy?.name ?? null,
      step: b.step,
      targetEpisodes: b.targetEpisodes,
      sceneText: b.sceneText,
      hasSceneImage: b.hasSceneImage,
      plan: b.plan ? { summary: b.plan.summary, steps: b.plan.steps.map((s) => ({ title: s.title, episodes: s.episodes })) } : null,
      teleopStartedAt: b.teleopStartedAt,
      teleopEndedAt: b.teleopEndedAt,
      minutes: b.times.teleopMinutes,
      datasets: b.datasets.map((d) => ({
        name: d.name,
        status: d.analysisStatus,
        episodes: d.analysis?.episodes ?? d.episodeCount,
        accepted: d.analysis?.counts.accept ?? 0,
        review: d.analysis?.counts.review ?? 0,
        rejected: d.analysis?.counts.reject ?? 0,
        medianSeconds: d.analysis?.medianDurationSeconds ?? null,
        specName: d.analysis?.specName ?? null,
      })),
      totals: b.totals,
    })),
    times: view.times,
    downtime: row.downtime ?? [],
    totals: view.totals,
    evaluation: view.evaluation,
    notes: row.notes,
    closedAt: view.closedAt,
  };
}

/** A block's scene photo for the print view: the block must belong to the day behind the share id. */
export async function blockOfDay(day: DayProtocolSelect, blockId: string) {
  const rows = await getDb().select().from(blocks).where(and(eq(blocks.id, blockId), eq(blocks.dayProtocolId, day.id))).limit(1);
  if (!rows[0]) throw new NotFoundError("Block");
  return rows[0];
}
