/**
 * Datasets: one uploaded LeRobot dataset per recording run of a block.
 *
 * GYM owns the recorded data. The upload (a zip with data, videos and meta)
 * goes into the configured storage (lib/storage), and the critics are handed a
 * temporary link to it rather than the bytes: they fetch what they need for
 * that one job and keep nothing. So the data lies where the installation wants
 * it, an export still works months later, and the analysis service can be
 * replaced or wiped without losing a recording.
 *
 * GYM keeps the dataset row, mirrors the job's result (lib/critics/sync.ts)
 * and shows verdicts, flags and the session profile to the operator. A block
 * has N datasets, every dataset has exactly one critics run. The rollouts of
 * an evaluation block are datasets like any other; only the export leaves
 * them out.
 */
import { and, asc, desc, eq } from "drizzle-orm";
import * as v from "valibot";
import { getDb } from "@framework/lib/db/db-connection";
import { blocks, datasets, dayProtocols, episodes, skills, type BlockSelect, type DatasetSelect, type EpisodeSelect } from "../../db/schema";
import { criticsClient, CriticsError, type CriticsPurpose } from "../critics/client";
import { refreshDataset, syncDataset, upgradeStaleSummaries } from "../critics/sync";
import { putFile, removeFile, shareFile } from "../storage";
import { recordAudit, type Actor } from "./audit";
import { getBlockRow } from "./blocks";
import { DATASET_BUCKET } from "./buckets";
import { ConflictError, InvalidInputError, NotFoundError, UpstreamError } from "./errors";
import { closeIntervals } from "./teleop";
import { utcRow, utcRows } from "./time";

/** The dataset as the API returns it: the full report is left out, it is large and has its own endpoint. */
export type DatasetView = Omit<DatasetSelect, "report"> & { episodes: EpisodeSelect[]; hasReport: boolean };

const toView = (row: DatasetSelect, eps: EpisodeSelect[]): DatasetView => {
  const { report, ...rest } = utcRow(row);
  return { ...rest, episodes: utcRows(eps), hasReport: !!report };
};

const safeName = (s: string) => s.replace(/[^A-Za-z0-9_.-]+/g, "_").replace(/^[._]+|[._]+$/g, "") || "dataset";

/**
 * How long a link handed to the critics stays good. Long enough for the
 * service to fetch a dataset of a few hundred megabytes over the internal
 * network and then some, short enough that a link which leaks is worth little.
 * The framework caps it at 24 hours whatever is set here.
 */
const shareTtlSeconds = (): number => {
  const configured = Number(process.env.GYM_DATASET_SHARE_TTL_SECONDS);
  return Number.isInteger(configured) && configured > 0 ? configured : 3600;
};

/** A temporary link to a stored dataset, for the critics. */
export const shareDataset = (tenantId: string, ref: string) =>
  shareFile(tenantId, DATASET_BUCKET, ref, { expiresInSeconds: shareTtlSeconds() });

/**
 * The zip, however it arrived: as one multipart request or assembled from the
 * chunks of a resumable upload (lib/gym/dataset-uploads.ts). The blob is what
 * goes to the critics, so it may be a file on disk as well as an uploaded one.
 */
export interface DatasetSource {
  /** the file the operator picked; names the dataset unless `displayName` is given */
  fileName: string;
  bytes: number;
  blob: Blob;
  /** the name the operator typed for the dataset */
  displayName?: string;
  /** the content type of the upload, when there was one */
  contentType?: string;
}

/**
 * Is this a zipped LeRobot dataset, as far as the name and the content type
 * can say? Checked before a chunked upload starts as well, so the operator
 * hears about the wrong file before sending it and not after.
 */
export function assertDatasetZip(fileName: string, bytes: number, contentType?: string): void {
  if (!bytes) throw new InvalidInputError("The upload is empty");
  if (!/\.zip$/i.test(fileName) && contentType !== "application/zip" && contentType !== "application/x-zip-compressed") {
    throw new InvalidInputError("Upload the LeRobot dataset as one zip archive (data, videos and meta)");
  }
}

/**
 * Upload a zipped LeRobot dataset for a block and start the critics run. The
 * upload ends the window that is open (recording is over once the data is
 * out) and the wizard moves to "review"; the result arrives asynchronously
 * (see lib/critics/sync.ts).
 */
export const uploadDataset = (tenantId: string, actor: Actor, blockId: string, file: File, nameOverride?: string): Promise<DatasetView> =>
  createDataset(tenantId, actor, blockId, { fileName: file.name, bytes: file.size, blob: file, displayName: nameOverride, contentType: file.type });

/** How the critics judge a block's datasets: an evaluation block's episodes are rollouts. */
export const purposeOf = (kind: BlockSelect["kind"]): CriticsPurpose => (kind === "evaluation" ? "evaluation" : "recording");

/** The same, from a zip that is already on disk: the shared core of both upload paths. */
export async function createDataset(tenantId: string, actor: Actor, blockId: string, source: DatasetSource): Promise<DatasetView> {
  const block = await getBlockRow(tenantId, blockId);
  assertDatasetZip(source.fileName, source.bytes, source.contentType);
  const skill = (await getDb().select().from(skills).where(eq(skills.id, block.skillId)).limit(1))[0]!;
  const day = (await getDb().select({ date: dayProtocols.date }).from(dayProtocols).where(eq(dayProtocols.id, block.dayProtocolId)).limit(1))[0]!;
  const displayName = (source.displayName?.trim() || source.fileName.replace(/\.zip$/i, "")).slice(0, 300);
  // unique inside the critics service: the day and a short random suffix keep repeated uploads apart
  const criticsName = `${safeName(displayName)}_${day.date.replace(/-/g, "")}_${Math.random().toString(36).slice(2, 8)}`;

  // the zip first: it is what GYM keeps, and the critics only ever see a link
  // to it. A job that cannot be started is a dataset that can be analysed
  // again; a zip that was never stored is a recording that is gone.
  const stored = await putFile(tenantId, DATASET_BUCKET, new File([source.blob], source.fileName, { type: "application/zip" }));
  let jobId: string;
  try {
    const share = await shareDataset(tenantId, stored.ref);
    // the skill's spec says what the task is; the kind of the block says what the
    // episodes are: demonstrations for training or rollouts of a policy
    ({ job_id: jobId } = await criticsClient.createJob(share.url, skill.criticSpecName ?? null, { run_hard: true, run_soft: true, contact_sheets: true }, purposeOf(block.kind)));
  } catch (error) {
    // nothing points at the zip yet, so it would be orphaned for ever
    await removeFile(tenantId, DATASET_BUCKET, stored.ref).catch(() => undefined);
    throw error;
  }

  const [ds] = await getDb()
    .insert(datasets)
    .values({
      tenantId,
      skillId: block.skillId,
      dayProtocolId: block.dayProtocolId,
      blockId: block.id,
      name: displayName,
      sourceFileName: source.fileName,
      bytes: source.bytes,
      // the critics count the episodes while they prepare; lib/critics/sync.ts
      // writes the number onto the row when the run reports them
      episodeCount: 0,
      storageRef: stored.ref,
      criticsDatasetName: criticsName,
      criticsJobId: jobId,
      criticSpecName: skill.criticSpecName ?? null,
      analysisStatus: "queued",
      uploadedBy: actor.userId,
    })
    .returning();
  const now = new Date().toISOString();
  await getDb()
    .update(blocks)
    .set({ teleopEndedAt: now, teleopIntervals: closeIntervals(block.teleopIntervals ?? [], now), step: "review", updatedAt: now })
    .where(eq(blocks.id, block.id));
  await recordAudit(tenantId, { skillId: block.skillId, dayProtocolId: block.dayProtocolId, blockId: block.id }, actor, "dataset.uploaded", {
    datasetId: ds!.id,
    kind: block.kind,
    name: displayName,
    bytes: source.bytes,
    criticsDataset: criticsName,
    jobId,
    storage: stored.driver,
    spec: skill.criticSpecName ?? "auto",
    purpose: purposeOf(block.kind),
  });
  return toView(await syncDataset(ds!), []);
}

export async function getDatasetRow(tenantId: string, id: string): Promise<DatasetSelect> {
  const rows = await getDb()
    .select()
    .from(datasets)
    .where(and(eq(datasets.id, id), eq(datasets.tenantId, tenantId)))
    .limit(1);
  if (!rows[0]) throw new NotFoundError("Dataset");
  return (await upgradeStaleSummaries([await syncDataset(rows[0])]))[0]!;
}

export async function getDataset(tenantId: string, id: string): Promise<DatasetView> {
  const row = await getDatasetRow(tenantId, id);
  const eps = await getDb().select().from(episodes).where(eq(episodes.datasetId, id)).orderBy(asc(episodes.index));
  return toView(row, eps);
}

export async function listDatasets(
  tenantId: string,
  filter: { skillId?: string; dayProtocolId?: string; blockId?: string; limit?: number } = {},
): Promise<Omit<DatasetSelect, "report">[]> {
  const conditions = [eq(datasets.tenantId, tenantId)];
  if (filter.skillId) conditions.push(eq(datasets.skillId, filter.skillId));
  if (filter.dayProtocolId) conditions.push(eq(datasets.dayProtocolId, filter.dayProtocolId));
  if (filter.blockId) conditions.push(eq(datasets.blockId, filter.blockId));
  const rows = await getDb()
    .select()
    .from(datasets)
    .where(and(...conditions))
    .orderBy(desc(datasets.createdAt))
    .limit(filter.limit ?? 500);
  return rows.map((row) => {
    const { report: _r, ...rest } = utcRow(row);
    return rest;
  });
}

/** Deleting removes the episodes and the stored zip, and asks the critics service to drop the job. */
export async function deleteDataset(tenantId: string, actor: Actor, id: string): Promise<void> {
  const ds = await getDatasetRow(tenantId, id);
  await getDb().delete(datasets).where(eq(datasets.id, id));
  if (ds.storageRef) await removeFile(tenantId, DATASET_BUCKET, ds.storageRef).catch(() => undefined);
  if (ds.criticsJobId) await criticsClient.deleteJob(ds.criticsJobId);
  await recordAudit(tenantId, { skillId: ds.skillId, dayProtocolId: ds.dayProtocolId, blockId: ds.blockId }, actor, "dataset.deleted", { datasetId: id, name: ds.name });
}

const flagList = v.pipe(v.array(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(80))), v.maxLength(200));
export const findingOverridesSchema = v.object({
  /** findings that only cap an episode at review: a warning, not a reject */
  reviewFlags: v.optional(flagList, []),
  /** findings muted for this run: informational */
  ignoreFlags: v.optional(flagList, []),
  /** critics that do not apply to this dataset (tracking_error, duplication, vlm, …): no weight, no gate, no flags */
  disabledCritics: v.optional(flagList, []),
});

/**
 * Downgrade findings of a dataset's critics run, or switch critics off for
 * it. The critics are still the judge: they replay the verdicts with the
 * overrides and GYM mirrors the result again. The human review of the
 * episodes survives, and so does the operator's selection where the verdict
 * did not move. Passing empty lists gives the run back as the critics
 * scored it.
 */
export async function setFindingOverrides(tenantId: string, actor: Actor, id: string, input: unknown): Promise<DatasetView> {
  const data = v.parse(findingOverridesSchema, input);
  const ds = await getDatasetRow(tenantId, id);
  if (ds.analysisStatus !== "done" || !ds.criticsJobId) throw new ConflictError("Findings can be downgraded once the critics run is done");
  const ignore = [...new Set(data.ignoreFlags)].sort();
  const review = [...new Set(data.reviewFlags)].filter((f) => !ignore.includes(f)).sort();
  const disabled = [...new Set(data.disabledCritics)].sort();
  try {
    await criticsClient.setOverrides(ds.criticsJobId, { ignore_flags: ignore, review_flags: review, disabled_critics: disabled });
  } catch (error) {
    // an older critics service has no replay: say so instead of "job not found"
    if (error instanceof CriticsError && (error.status === 404 || error.status === 405)) {
      throw new UpstreamError("The data critics service does not know how to replay a run yet. Update the critics container to the version of this app.");
    }
    throw error;
  }
  const refreshed = await refreshDataset(ds);
  await recordAudit(tenantId, { skillId: ds.skillId, dayProtocolId: ds.dayProtocolId, blockId: ds.blockId }, actor, "dataset.findings.changed", {
    datasetId: id,
    name: ds.name,
    reviewFlags: review,
    ignoreFlags: ignore,
    disabledCritics: disabled,
    ...(refreshed.analysis?.counts ?? {}),
  });
  const eps = await getDb().select().from(episodes).where(eq(episodes.datasetId, id)).orderBy(asc(episodes.index));
  return toView(refreshed, eps);
}
