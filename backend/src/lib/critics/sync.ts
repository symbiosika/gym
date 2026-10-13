/**
 * Mirrors critics jobs into GYM.
 *
 * A dataset row starts as "queued" with the job id of the critics run. This
 * module asks the service how the job is doing and, when it is done, copies
 * report.json and selection.json onto the dataset, derives the compact
 * summary and writes one episode row per episode. Called on demand when a
 * block or dataset is read and once a minute by a cron job, so a run finishes
 * in GYM even when nobody is looking.
 */
import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "@framework/lib/db/db-connection";
import log from "@framework/lib/log";
import { datasets, episodes, type DatasetSelect, type EpisodeVerdict } from "../../db/schema";
import { recordAudit, SYSTEM_ACTOR } from "../gym/audit";
import { criticsClient, CriticsError, type CriticsJob } from "./client";
import { defaultSelected, episodeRows, SUMMARY_VERSION, summarize } from "./summary";

const OPEN_STATUSES = ["queued", "running"] as const;

/** Bring one dataset up to date with its critics job. Returns the (possibly updated) row. */
export async function syncDataset(row: DatasetSelect): Promise<DatasetSelect> {
  if (!OPEN_STATUSES.includes(row.analysisStatus as (typeof OPEN_STATUSES)[number])) return row;
  if (!row.criticsJobId) return await fail(row, "The critics job was never started");

  let job: CriticsJob;
  try {
    job = await criticsClient.job(row.criticsJobId);
  } catch (error) {
    if (error instanceof CriticsError && error.status === 404) return await fail(row, "The critics job disappeared");
    // the service is temporarily unreachable: try again next time
    log.error(`gym: critics job ${row.criticsJobId} could not be read: ${error instanceof Error ? error.message : String(error)}`);
    return row;
  }

  if (job.status === "failed") return await fail(row, job.error ?? "The critics run failed");
  if (job.status !== "done") {
    const status = job.status === "queued" ? "queued" : "running";
    if (status !== row.analysisStatus || JSON.stringify(job.progress ?? {}) !== JSON.stringify(row.progress ?? {})) {
      const [updated] = await getDb()
        .update(datasets)
        .set({ analysisStatus: status, progress: job.progress ?? {}, updatedAt: new Date().toISOString() })
        .where(eq(datasets.id, row.id))
        .returning();
      return updated!;
    }
    return row;
  }

  return mirrorResult(row, job.progress ?? {}, "dataset.analysed");
}

/**
 * The verdict the operator's selection ends up with after the critics judged
 * an episode again (overrides). An episode that is new, or whose verdict did
 * not move, keeps its decision; one that turned into a reject is deselected
 * and one that stopped being a reject comes back, because the reason it was
 * out is gone.
 */
export function selectedAfter(previous: { verdict: string; selected: boolean } | undefined, verdict: EpisodeVerdict): boolean {
  if (!previous) return defaultSelected(verdict);
  if (previous.verdict === verdict) return previous.selected;
  if (verdict === "reject") return false;
  if (previous.verdict === "reject") return true;
  return previous.selected;
}

/**
 * Copy report.json and selection.json of a finished run onto the dataset and
 * bring the episode rows in line with it. The rows are updated in place, so
 * an episode keeps its id and everything a person wrote on it (human verdict,
 * failure code, note, variation) when the critics judge it again.
 */
async function mirrorResult(row: DatasetSelect, progress: Record<string, { done: number; total: number }>, action: string): Promise<DatasetSelect> {
  const [report, selection] = [await criticsClient.report(row.criticsJobId!), await criticsClient.selection(row.criticsJobId!)];
  const summary = summarize(row.criticsJobId!, report, selection);
  const rows = episodeRows(report, selection);
  const db = getDb();
  const existing = await db.select().from(episodes).where(eq(episodes.datasetId, row.id));
  const byIndex = new Map(existing.map((e) => [e.index, e]));
  const seen = new Set<number>();
  for (const e of rows) {
    seen.add(e.index);
    const prev = byIndex.get(e.index);
    const values = {
      task: e.task,
      frames: e.frames,
      durationSeconds: e.durationSeconds,
      verdict: e.verdict,
      totalScore: e.totalScore,
      hardScore: e.hardScore,
      softScore: e.softScore,
      flags: e.flags,
      reason: e.reason,
      criticScores: e.criticScores,
      error: e.error,
      selected: selectedAfter(prev, e.verdict),
    };
    if (prev) await db.update(episodes).set(values).where(eq(episodes.id, prev.id));
    else await db.insert(episodes).values({ tenantId: row.tenantId, skillId: row.skillId, datasetId: row.id, index: e.index, ...values });
  }
  const gone = existing.filter((e) => !seen.has(e.index)).map((e) => e.id);
  if (gone.length) await db.delete(episodes).where(inArray(episodes.id, gone));
  const now = new Date().toISOString();
  const [updated] = await db
    .update(datasets)
    .set({
      analysisStatus: "done",
      progress,
      analysis: summary,
      report,
      selection,
      episodeCount: rows.length,
      analysisError: null,
      updatedAt: now,
    })
    .where(eq(datasets.id, row.id))
    .returning();
  await recordAudit(
    row.tenantId,
    { skillId: row.skillId, dayProtocolId: row.dayProtocolId, blockId: row.blockId },
    SYSTEM_ACTOR,
    action,
    { datasetId: row.id, name: row.name, jobId: row.criticsJobId, episodes: rows.length, ...summary.counts, spec: summary.specName },
  );
  return updated!;
}

/**
 * A dataset analysed before the summary changed shape carries an old summary
 * without the newer fields (critics, overrides, the model's word). It is
 * rebuilt here from the report and selection that are stored on the row, so
 * no call to the critics is needed and every dataset reads the same way. Rows
 * that are not done, have no report or are current are left alone.
 */
export async function upgradeStaleSummaries(rows: DatasetSelect[]): Promise<DatasetSelect[]> {
  const out: DatasetSelect[] = [];
  for (const row of rows) {
    const stale = row.analysisStatus === "done" && row.report && row.selection && row.criticsJobId && row.analysis?.version !== SUMMARY_VERSION;
    if (!stale) {
      out.push(row);
      continue;
    }
    const [updated] = await getDb()
      .update(datasets)
      .set({ analysis: summarize(row.criticsJobId!, row.report!, row.selection!) })
      .where(eq(datasets.id, row.id))
      .returning();
    out.push(updated ?? row);
  }
  return out;
}

/** The stale summaries among the given dataset ids, rebuilt; returns how many were. */
export async function upgradeStaleSummariesOf(datasetIds: string[]): Promise<number> {
  if (!datasetIds.length) return 0;
  const candidates = await getDb()
    .select({ id: datasets.id, analysis: datasets.analysis, analysisStatus: datasets.analysisStatus })
    .from(datasets)
    .where(inArray(datasets.id, datasetIds));
  const stale = candidates.filter((c) => c.analysisStatus === "done" && c.analysis?.version !== SUMMARY_VERSION).map((c) => c.id);
  if (!stale.length) return 0;
  const rows = await getDb().select().from(datasets).where(inArray(datasets.id, stale));
  await upgradeStaleSummaries(rows);
  return stale.length;
}

/** Read a finished run again, after its verdicts were replayed by the critics. */
export async function refreshDataset(row: DatasetSelect): Promise<DatasetSelect> {
  if (row.analysisStatus !== "done" || !row.criticsJobId) return row;
  return mirrorResult(row, row.progress ?? {}, "dataset.reanalysed");
}

async function fail(row: DatasetSelect, message: string): Promise<DatasetSelect> {
  const [updated] = await getDb()
    .update(datasets)
    .set({ analysisStatus: "failed", analysisError: message.slice(0, 4000), updatedAt: new Date().toISOString() })
    .where(eq(datasets.id, row.id))
    .returning();
  await recordAudit(
    row.tenantId,
    { skillId: row.skillId, dayProtocolId: row.dayProtocolId, blockId: row.blockId },
    SYSTEM_ACTOR,
    "dataset.failed",
    { datasetId: row.id, name: row.name, error: message.slice(0, 500) },
  );
  return updated!;
}

/** Sync every open dataset of the given blocks (sequential: the local database serves one query at a time). */
export async function syncOpenDatasets(blockIds: string[]): Promise<void> {
  if (!blockIds.length) return;
  const open = await getDb()
    .select()
    .from(datasets)
    .where(and(inArray(datasets.blockId, blockIds), inArray(datasets.analysisStatus, [...OPEN_STATUSES])));
  for (const row of open) await syncDataset(row);
}

/** Cron entry: every open dataset of every organisation. */
export async function syncAllOpenDatasets(): Promise<number> {
  const open = await getDb()
    .select()
    .from(datasets)
    .where(inArray(datasets.analysisStatus, [...OPEN_STATUSES]));
  for (const row of open) await syncDataset(row);
  return open.length;
}

/** Blocks that still have an open dataset, to decide whether a view needs a sync. */
export async function blocksWithOpenDatasets(blockIds: string[]): Promise<Set<string>> {
  if (!blockIds.length) return new Set();
  const rows = await getDb()
    .select({ blockId: datasets.blockId })
    .from(datasets)
    .where(and(inArray(datasets.blockId, blockIds), inArray(datasets.analysisStatus, [...OPEN_STATUSES])));
  return new Set(rows.map((r) => r.blockId));
}

