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
 * has N datasets, every dataset has one critics run at a time. The rollouts of
 * an evaluation block are datasets like any other; only the export leaves
 * them out.
 *
 * A recording is analysed in two steps. The upload starts a measuring pass:
 * the hard critics alone, no model, no contact sheets. It gives the episodes
 * and what the prompt check reads (lib/gym/prompts.ts), so the operator can
 * correct the prompts first. The analysis the operator then starts
 * (`analyseBlock`, on the way to the review) is the full run, and the critics
 * judge every episode against its corrected prompt. Only the episodes of a
 * full run count (`datasets.analysis_pass`). Rollouts are analysed at once.
 */
import { and, asc, desc, eq, inArray, isNotNull } from "drizzle-orm";
import * as v from "valibot";
import { getDb } from "@framework/lib/db/db-connection";
import { blocks, datasets, dayProtocols, episodes, skills, type BlockSelect, type DatasetSelect, type EpisodeSelect, type SkillSelect } from "../../db/schema";
import { criticsClient, CriticsError, type CriticsPurpose, type CriticsRunOptions, type SpecOverrides } from "../critics/client";
import { refreshDataset, syncDataset, upgradeStaleSummaries } from "../critics/sync";
import { ensureSpec, specNameOf } from "../critics/specs";
import { putFile, removeFile, shareFile, storageDriver } from "../storage";
import { recordAudit, type Actor } from "./audit";
import { getBlockRow } from "./blocks";
import { DATASET_BUCKET, REPORT_BUCKET, UPLOAD_CHUNK_BUCKET } from "./buckets";
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

/**
 * A link of GYM's own as the critics reach it. A link to a file in the
 * database or on the disc is GYM's address (`BASE_URL`) plus a token; where
 * the critics reach GYM by another address, `CRITICS_LINK_BASE_URL` takes its
 * place. That is the case in local development, where the critics run in a
 * container and `localhost` is the container itself
 * (`http://host.docker.internal:3000`, docker-compose.critics.yml). A link
 * that is not GYM's own (a presigned object store URL) is left as it is: its
 * signature covers its host.
 */
export function linkForCritics(url: string, baseUrl = process.env.BASE_URL, criticsBaseUrl = process.env.CRITICS_LINK_BASE_URL): string {
  const from = baseUrl?.trim().replace(/\/+$/, "");
  const to = criticsBaseUrl?.trim().replace(/\/+$/, "");
  if (!from || !to || !url.startsWith(from)) return url;
  const rest = url.slice(from.length);
  return rest === "" || rest.startsWith("/") || rest.startsWith("?") ? to + rest : url;
}

/** A temporary link to a stored dataset, for the critics. */
export const shareDataset = (tenantId: string, ref: string) =>
  shareFile(tenantId, DATASET_BUCKET, ref, { expiresInSeconds: shareTtlSeconds() });

/** Where the bytes of a dataset lie: one zip, or the chunks it was uploaded in. */
type StoredDataset = Pick<DatasetSelect, "storageRef" | "storageParts">;

/** What the critics are handed: a link to the zip, or one link per part, in order, which they join. */
export type DatasetLinks = { dataset: string } | { dataset_parts: string[] };

/** Does GYM hold the bytes of this dataset? Not for one from before it kept the uploads. */
export const isDatasetStored = (ds: StoredDataset): boolean => !!ds.storageRef || !!ds.storageParts?.length;

/**
 * Fresh temporary links to a stored dataset, for one job or one merge. Signing
 * a link costs no request, so a dataset of a few hundred parts is a few
 * hundred signatures and nothing more.
 */
export async function datasetLinks(tenantId: string, ds: StoredDataset): Promise<DatasetLinks> {
  if (ds.storageParts?.length) {
    const ttl = { expiresInSeconds: shareTtlSeconds() };
    return {
      dataset_parts: await Promise.all(ds.storageParts.map(async (ref) => linkForCritics((await shareFile(tenantId, UPLOAD_CHUNK_BUCKET, ref, ttl)).url))),
    };
  }
  if (ds.storageRef) return { dataset: linkForCritics((await shareDataset(tenantId, ds.storageRef)).url) };
  throw new ConflictError("GYM does not hold the data of this dataset");
}

/**
 * Remove the stored bytes of a dataset, the zip or its parts. Never fails the
 * caller: a file that cannot be removed must not keep a deleted dataset alive.
 */
export async function removeDatasetFiles(tenantId: string, ds: StoredDataset & { reportHtmlRef?: string | null }): Promise<void> {
  if (ds.storageRef) await removeFile(tenantId, DATASET_BUCKET, ds.storageRef).catch(() => undefined);
  for (const ref of ds.storageParts ?? []) await removeFile(tenantId, UPLOAD_CHUNK_BUCKET, ref).catch(() => undefined);
  if (ds.reportHtmlRef) await removeFile(tenantId, REPORT_BUCKET, ds.reportHtmlRef).catch(() => undefined);
}

/**
 * The zip, however it arrived: as one multipart request (`blob`, stored here
 * as one file) or as the chunks of a resumable upload (`parts`, the storage
 * references of the chunks in order, see lib/gym/dataset-uploads.ts). The
 * parts are already stored and become the dataset as they are: an archive of
 * several gigabytes is never put together on this side.
 */
export type DatasetSource = {
  /** the file the operator picked; names the dataset unless `displayName` is given */
  fileName: string;
  bytes: number;
  /** the name the operator typed for the dataset */
  displayName?: string;
  /** the content type of the upload, when there was one */
  contentType?: string;
  /** the run facts of this dataset, laid over the skill's spec by the critics (the active arm) */
  specOverrides?: SpecOverrides | null;
} & ({ blob: Blob } | { parts: string[] });

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
export const uploadDataset = (
  tenantId: string,
  actor: Actor,
  blockId: string,
  file: File,
  nameOverride?: string,
  specOverrides?: SpecOverrides | null,
): Promise<DatasetView> =>
  createDataset(tenantId, actor, blockId, { fileName: file.name, bytes: file.size, blob: file, displayName: nameOverride, contentType: file.type, specOverrides });

/** How the critics judge a block's datasets: an evaluation block's episodes are rollouts. */
export const purposeOf = (kind: BlockSelect["kind"]): CriticsPurpose => (kind === "evaluation" ? "evaluation" : "recording");

/** The measuring pass of a recording: the hard critics alone, enough for the prompt check. */
export const MEASURE_RUN: CriticsRunOptions = { run_hard: true, run_soft: false, contact_sheets: false };
/** The analysis: every critic, the model among them, and the contact sheets. */
export const FULL_RUN: CriticsRunOptions = { run_hard: true, run_soft: true, contact_sheets: true };

/**
 * Start one critics job over a stored dataset with the skill's spec. A spec
 * that was deleted since the skill named it must not fail the run: it falls
 * back to the auto spec, as deleting a spec promises. One the critics merely
 * lost (a redeploy) is put back from GYM's copy first.
 */
async function startJob(
  tenantId: string,
  block: BlockSelect,
  skill: SkillSelect,
  stored: StoredDataset,
  specOverrides: SpecOverrides | null,
  options: CriticsRunOptions,
): Promise<{ jobId: string; specName: string | null; wantedSpec: string | null }> {
  const wantedSpec = skill.criticSpecName ?? null;
  const specName = wantedSpec && (await ensureSpec(tenantId, wantedSpec)) ? specNameOf(wantedSpec) : null;
  const links = await datasetLinks(tenantId, stored);
  // the skill's spec says what the task is; the kind of the block says what the
  // episodes are: demonstrations for training or rollouts of a policy
  const { job_id: jobId } = await criticsClient.createJob(links, specName, options, purposeOf(block.kind), true, specOverrides);
  return { jobId, specName, wantedSpec };
}

/** The shared core of both upload paths: store the zip (unless it is stored in parts already) and start the run. */
export async function createDataset(tenantId: string, actor: Actor, blockId: string, source: DatasetSource): Promise<DatasetView> {
  const block = await getBlockRow(tenantId, blockId);
  assertDatasetZip(source.fileName, source.bytes, source.contentType);
  const skill = (await getDb().select().from(skills).where(eq(skills.id, block.skillId)).limit(1))[0]!;
  const day = (await getDb().select({ date: dayProtocols.date }).from(dayProtocols).where(eq(dayProtocols.id, block.dayProtocolId)).limit(1))[0]!;
  const displayName = (source.displayName?.trim() || source.fileName.replace(/\.zip$/i, "")).slice(0, 300);
  // unique inside the critics service: the day and a short random suffix keep repeated uploads apart
  const criticsName = `${safeName(displayName)}_${day.date.replace(/-/g, "")}_${Math.random().toString(36).slice(2, 8)}`;
  // a recording is measured first and analysed when the operator starts it; rollouts at once
  const measure = block.kind === "recording";

  // the zip first: it is what GYM keeps, and the critics only ever see a link
  // to it. A job that cannot be started is a dataset that can be analysed
  // again; a zip that was never stored is a recording that is gone.
  // Parts are stored already and still belong to their upload: if the run
  // cannot be started they stay with it, so the operator can try again
  // without sending the data a second time.
  const stored: StoredDataset & { driver: string } =
    "parts" in source
      ? { storageRef: null, storageParts: source.parts, driver: storageDriver() }
      : await putFile(tenantId, DATASET_BUCKET, new File([source.blob], source.fileName, { type: "application/zip" })).then((f) => ({
          storageRef: f.ref,
          storageParts: null,
          driver: f.driver,
        }));
  let job: Awaited<ReturnType<typeof startJob>>;
  try {
    job = await startJob(tenantId, block, skill, stored, source.specOverrides ?? null, measure ? MEASURE_RUN : FULL_RUN);
  } catch (error) {
    // nothing points at a zip stored here yet, so it would be orphaned for ever
    if (stored.storageRef) await removeFile(tenantId, DATASET_BUCKET, stored.storageRef).catch(() => undefined);
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
      storageRef: stored.storageRef,
      storageParts: stored.storageParts,
      specOverrides: source.specOverrides ?? null,
      criticsDatasetName: criticsName,
      criticsJobId: job.jobId,
      criticSpecName: job.specName,
      analysisStatus: measure ? "measuring" : "queued",
      analysisPass: measure ? "measure" : "full",
      uploadedBy: actor.userId,
    })
    .returning();
  // the upload ends the window that is open; a recording stays at the upload
  // until the operator starts the analysis, rollouts go on to the review
  const now = new Date().toISOString();
  await getDb()
    .update(blocks)
    .set({ teleopEndedAt: now, teleopIntervals: closeIntervals(block.teleopIntervals ?? [], now), step: measure ? "upload" : "review", updatedAt: now })
    .where(eq(blocks.id, block.id));
  await recordAudit(tenantId, { skillId: block.skillId, dayProtocolId: block.dayProtocolId, blockId: block.id }, actor, "dataset.uploaded", {
    datasetId: ds!.id,
    kind: block.kind,
    name: displayName,
    bytes: source.bytes,
    criticsDataset: criticsName,
    jobId: job.jobId,
    run: measure ? "measure" : "full",
    storage: stored.driver,
    parts: stored.storageParts?.length ?? 0,
    spec: job.wantedSpec && !job.specName ? `auto (stored spec '${job.wantedSpec}' missing)` : (job.specName ?? "auto"),
    purpose: purposeOf(block.kind),
    specOverrides: source.specOverrides ?? null,
  });
  return toView(await syncDataset(ds!), []);
}

/** The corrected prompts of a dataset's episodes, { episode index: prompt }; null when none was corrected. */
export async function correctedPromptsOf(datasetId: string): Promise<Record<string, string> | null> {
  const rows = await getDb()
    .select({ index: episodes.index, prompt: episodes.promptOverride })
    .from(episodes)
    .where(and(eq(episodes.datasetId, datasetId), isNotNull(episodes.promptOverride)))
    .orderBy(asc(episodes.index));
  const out = Object.fromEntries(rows.filter((r) => r.prompt).map((r) => [String(r.index), r.prompt!]));
  return Object.keys(out).length ? out : null;
}

const RUNNING: DatasetSelect["analysisStatus"][] = ["queued", "running"];

/**
 * Start the analysis of one dataset: the full critics run, with the prompts a
 * person corrected handed over, so every critic (the model among them) judges
 * an episode against the prompt it is trained with. Replaces the dataset's
 * run: a measuring pass still going is dropped, a finished one stays mirrored
 * until the analysis arrives. Also the way to analyse a dataset again after
 * its prompts changed. The episodes keep their ids and what people wrote on
 * them (lib/critics/sync.ts).
 */
export async function analyseDataset(tenantId: string, actor: Actor, id: string): Promise<DatasetView> {
  const ds = await getDatasetRow(tenantId, id);
  if (RUNNING.includes(ds.analysisStatus)) throw new ConflictError("The analysis of this dataset is running already");
  if (!isDatasetStored(ds)) {
    throw new InvalidInputError(`The dataset "${ds.name}" was recorded before GYM kept the uploads, so it cannot be analysed again. Upload it again.`);
  }
  const block = await getBlockRow(tenantId, ds.blockId);
  const skill = (await getDb().select().from(skills).where(eq(skills.id, ds.skillId)).limit(1))[0]!;
  const prompts = await correctedPromptsOf(id);
  const job = await startJob(tenantId, block, skill, ds, ds.specOverrides ?? null, prompts ? { ...FULL_RUN, prompts } : FULL_RUN);
  const previousJob = ds.criticsJobId;
  const [updated] = await getDb()
    .update(datasets)
    .set({
      criticsJobId: job.jobId,
      criticSpecName: job.specName,
      analysisStatus: "queued",
      analysisError: null,
      progress: {},
      analysedPrompts: prompts,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(datasets.id, id))
    .returning();
  // the critics keep nothing for good anyway; the old job is only disc space now
  if (previousJob) await criticsClient.deleteJob(previousJob).catch(() => undefined);
  await recordAudit(tenantId, { skillId: ds.skillId, dayProtocolId: ds.dayProtocolId, blockId: ds.blockId }, actor, "dataset.analysis_started", {
    datasetId: id,
    name: ds.name,
    jobId: job.jobId,
    previousJob,
    after: ds.analysisStatus,
    correctedPrompts: Object.keys(prompts ?? {}).length,
    spec: job.wantedSpec && !job.specName ? `auto (stored spec '${job.wantedSpec}' missing)` : (job.specName ?? "auto"),
  });
  const eps = await getDb().select().from(episodes).where(eq(episodes.datasetId, id)).orderBy(asc(episodes.index));
  return toView(updated!, eps);
}

/**
 * Start the analysis of every dataset of a block that was only measured so
 * far (or whose measuring failed). Called on the way from the upload to the
 * review; datasets analysed already are left alone.
 */
export async function analyseBlock(tenantId: string, actor: Actor, blockId: string): Promise<number> {
  const rows = await getDb()
    .select({ id: datasets.id, status: datasets.analysisStatus, pass: datasets.analysisPass })
    .from(datasets)
    .where(and(eq(datasets.tenantId, tenantId), eq(datasets.blockId, blockId), eq(datasets.analysisPass, "measure"), inArray(datasets.analysisStatus, ["measuring", "measured", "failed"])))
    .orderBy(asc(datasets.createdAt));
  for (const r of rows) await analyseDataset(tenantId, actor, r.id);
  return rows.length;
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

/** Deleting removes the episodes and the stored zip (or its parts), and asks the critics service to drop the job. */
export async function deleteDataset(tenantId: string, actor: Actor, id: string): Promise<void> {
  const ds = await getDatasetRow(tenantId, id);
  await getDb().delete(datasets).where(eq(datasets.id, id));
  await removeDatasetFiles(tenantId, ds);
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

/**
 * A person says they have seen that the language model did not judge this
 * dataset, or takes that back. Nothing else changes: the failure stays in the
 * analysis, only no longer as an open one.
 */
export async function setVlmFailureAck(tenantId: string, actor: Actor, id: string, acknowledged: boolean): Promise<DatasetView> {
  const ds = await getDatasetRow(tenantId, id);
  if (acknowledged && !ds.analysis?.softCriticsFailed) throw new ConflictError("The dataset has no VLM failure to acknowledge");
  const vlmFailureAck = acknowledged ? { by: actor.userId, byName: actor.userName, at: new Date().toISOString() } : null;
  const [updated] = await getDb().update(datasets).set({ vlmFailureAck }).where(eq(datasets.id, id)).returning();
  await recordAudit(
    tenantId,
    { skillId: ds.skillId, dayProtocolId: ds.dayProtocolId, blockId: ds.blockId },
    actor,
    acknowledged ? "dataset.vlm_failure_ack" : "dataset.vlm_failure_unack",
    { datasetId: id, name: ds.name },
  );
  const eps = await getDb().select().from(episodes).where(eq(episodes.datasetId, id)).orderBy(asc(episodes.index));
  return toView(updated!, eps);
}

/**
 * Take a recording dataset out of the skill's selection as a whole, or back
 * in. The ticks of its episodes are not touched: they are the operator's work
 * and come back with the dataset.
 */
export async function setDatasetIncluded(tenantId: string, actor: Actor, id: string, included: boolean): Promise<DatasetView> {
  const ds = await getDatasetRow(tenantId, id);
  const block = await getDb().select({ kind: blocks.kind }).from(blocks).where(eq(blocks.id, ds.blockId)).limit(1);
  if (block[0]?.kind !== "recording") throw new InvalidInputError("Only the datasets of recording blocks are part of a selection");
  const [updated] = await getDb().update(datasets).set({ included }).where(eq(datasets.id, id)).returning();
  await recordAudit(tenantId, { skillId: ds.skillId, dayProtocolId: ds.dayProtocolId, blockId: ds.blockId }, actor, included ? "dataset.included" : "dataset.excluded", {
    datasetId: id,
    name: ds.name,
  });
  const eps = await getDb().select().from(episodes).where(eq(episodes.datasetId, id)).orderBy(asc(episodes.index));
  return toView(updated!, eps);
}
