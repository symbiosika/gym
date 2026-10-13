/**
 * Spec drafts: the spec wizard.
 *
 * Writing a critics spec by hand means knowing every field before seeing what
 * the critics make of the data. The wizard turns that around. A sample
 * dataset is uploaded for the time of the wizard, the critics run in auto
 * mode over X of its episodes (spread over the session) and generate a spec,
 * and the person walks through that spec step by step: task, robot and
 * cameras, technical checks, success indicators, thresholds. Every step shows
 * what the sample measured next to the field it concerns. A test run with the
 * drafted spec over the same episodes shows what it would decide before it is
 * stored.
 *
 * The draft row is the state of the wizard and every input is saved on it at
 * once. The sample is temporary: its chunks stay in the upload bucket as the
 * draft's `storageParts` and the critics get one link per chunk, exactly like
 * a dataset (lib/gym/datasets.ts). Finishing stores the spec in the critics
 * service, names it on the skill and removes the sample and the critics jobs;
 * discarding removes them without storing anything; a draft nobody came back
 * to for a week is cleared by the cleanup cron job.
 *
 * GYM does not judge anything here either: the runs are the critics', and
 * what the wizard shows is their report, read as it is.
 */
import { and, desc, eq, lt } from "drizzle-orm";
import * as v from "valibot";
import { getDb } from "@framework/lib/db/db-connection";
import log from "@framework/lib/log";
import { datasetUploads, skills, SPEC_DRAFT_SAMPLE, SPEC_DRAFT_STEPS, specDrafts, type SpecDraftRunStatus, type SpecDraftSelect } from "../../db/schema";
import { criticsClient, CriticsError, type CriticsJob, type DatasetReport } from "../critics/client";
import { saveSpecObject, specExists, specNameOf } from "../critics/specs";
import { removeFile } from "../storage";
import { recordAudit, type Actor } from "./audit";
import { UPLOAD_CHUNK_BUCKET } from "./buckets";
import { claimCompletedUpload, dropChunkFiles, releaseUpload } from "./dataset-uploads";
import { datasetLinks, purposeOf } from "./datasets";
import { ConflictError, InvalidInputError, NotFoundError } from "./errors";
import { getSkillRow } from "./skills";
import { utcRow } from "./time";

/** A draft nobody touched for this long is removed with its sample. */
const STALE_AFTER_DAYS = 7;

export const RUNS = ["analysis", "test"] as const;
export type SpecDraftRun = (typeof RUNS)[number];

/** The draft as the API returns it: the reports are left out (they have their own endpoint). */
export type SpecDraftView = Omit<SpecDraftSelect, "analysisReport" | "testReport"> & {
  skillName: string | null;
  /** the progress of a run that is still going, as the critics report it */
  analysisProgress: Record<string, { done: number; total: number }>;
  testProgress: Record<string, { done: number; total: number }>;
  /** the verdict counts of a finished run, for the overview */
  analysisCounts: Record<string, number> | null;
  testCounts: Record<string, number> | null;
};

const sampleSize = v.pipe(v.number(), v.integer(), v.minValue(SPEC_DRAFT_SAMPLE.min), v.maxValue(SPEC_DRAFT_SAMPLE.max));
const purpose = v.picklist(["recording", "evaluation"] as const);
const specObject = v.record(v.string(), v.unknown());

export const createSpecDraftSchema = v.object({
  name: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(200)), ""),
  skillId: v.optional(v.nullable(v.pipe(v.string(), v.uuid())), null),
  purpose: v.optional(purpose, "recording"),
  sampleSize: v.optional(sampleSize, SPEC_DRAFT_SAMPLE.default),
});

export const updateSpecDraftSchema = v.object({
  name: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(200))),
  skillId: v.optional(v.nullable(v.pipe(v.string(), v.uuid()))),
  purpose: v.optional(purpose),
  sampleSize: v.optional(sampleSize),
  step: v.optional(v.picklist(SPEC_DRAFT_STEPS)),
  spec: v.optional(v.nullable(specObject)),
});

export const finishSpecDraftSchema = v.object({
  name: v.pipe(v.string(), v.trim(), v.minLength(1, "The spec needs a name"), v.maxLength(200)),
  /** name the spec on the draft's skill, so its next uploads are judged with it */
  assignToSkill: v.optional(v.boolean(), true),
  /** replace a stored spec of the same name; without it that is refused */
  overwrite: v.optional(v.boolean(), false),
});

const OPEN: SpecDraftRunStatus[] = ["queued", "running"];

async function getDraftRow(tenantId: string, id: string): Promise<SpecDraftSelect> {
  const rows = await getDb()
    .select()
    .from(specDrafts)
    .where(and(eq(specDrafts.id, id), eq(specDrafts.tenantId, tenantId)))
    .limit(1);
  if (!rows[0]) throw new NotFoundError("Spec draft");
  return rows[0];
}

/** That the draft exists in the tenant: the gate of the sample upload routes. */
export const assertSpecDraft = async (tenantId: string, id: string): Promise<void> => {
  await getDraftRow(tenantId, id);
};

async function skillNames(tenantId: string, ids: (string | null)[]): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((id): id is string => !!id))];
  const out = new Map<string, string>();
  for (const id of wanted) {
    try {
      out.set(id, (await getSkillRow(tenantId, id)).name);
    } catch {
      /* a skill deleted in the meantime: the draft keeps its null */
    }
  }
  return out;
}

const toView = (
  row: SpecDraftSelect,
  skillName: string | null,
  progress: Partial<Record<SpecDraftRun, Record<string, { done: number; total: number }>>> = {},
): SpecDraftView => {
  const { analysisReport, testReport, ...rest } = utcRow(row);
  return {
    ...rest,
    skillName,
    analysisProgress: progress.analysis ?? {},
    testProgress: progress.test ?? {},
    analysisCounts: analysisReport?.counts ?? null,
    testCounts: testReport?.counts ?? null,
  };
};

const touch = (id: string, set: Partial<SpecDraftSelect>) =>
  getDb()
    .update(specDrafts)
    .set({ ...set, updatedAt: new Date().toISOString() })
    .where(eq(specDrafts.id, id))
    .returning()
    .then((rows) => rows[0]!);

export async function listSpecDrafts(tenantId: string): Promise<SpecDraftView[]> {
  const rows = await getDb().select().from(specDrafts).where(eq(specDrafts.tenantId, tenantId)).orderBy(desc(specDrafts.updatedAt));
  const names = await skillNames(tenantId, rows.map((r) => r.skillId));
  return rows.map((r) => toView(r, r.skillId ? (names.get(r.skillId) ?? null) : null));
}

/** Start the wizard. The name defaults to the skill's, as a spec name. */
export async function createSpecDraft(tenantId: string, actor: Actor, input: unknown): Promise<SpecDraftView> {
  const data = v.parse(createSpecDraftSchema, input);
  const skill = data.skillId ? await getSkillRow(tenantId, data.skillId) : null;
  const [row] = await getDb()
    .insert(specDrafts)
    .values({
      tenantId,
      skillId: skill?.id ?? null,
      name: specNameOf(data.name || skill?.name || ""),
      purpose: data.purpose,
      sampleSize: data.sampleSize,
      createdBy: actor.userId,
    })
    .returning();
  return toView(row!, skill?.name ?? null);
}

/** One draft, brought up to date with its critics runs. */
export async function getSpecDraft(tenantId: string, id: string): Promise<SpecDraftView> {
  let row = await getDraftRow(tenantId, id);
  const progress: Partial<Record<SpecDraftRun, Record<string, { done: number; total: number }>>> = {};
  for (const run of RUNS) {
    const synced = await syncRun(row, run);
    row = synced.row;
    progress[run] = synced.progress;
  }
  const names = await skillNames(tenantId, [row.skillId]);
  return toView(row, row.skillId ? (names.get(row.skillId) ?? null) : null, progress);
}

/** Save what the person entered: the wizard is stateful, every field goes here at once. */
export async function updateSpecDraft(tenantId: string, id: string, input: unknown): Promise<SpecDraftView> {
  const data = v.parse(updateSpecDraftSchema, input);
  const row = await getDraftRow(tenantId, id);
  if (data.skillId) await getSkillRow(tenantId, data.skillId);
  if (data.step && data.step !== "sample" && data.step !== "analysis" && !row.spec && !data.spec) {
    throw new ConflictError("The analysis of the sample has to finish before the spec can be worked on");
  }
  await touch(row.id, {
    ...(data.name !== undefined ? { name: specNameOf(data.name) } : {}),
    ...(data.skillId !== undefined ? { skillId: data.skillId } : {}),
    ...(data.purpose !== undefined ? { purpose: data.purpose } : {}),
    ...(data.sampleSize !== undefined ? { sampleSize: data.sampleSize } : {}),
    ...(data.step !== undefined ? { step: data.step } : {}),
    ...(data.spec !== undefined ? { spec: data.spec } : {}),
  });
  return getSpecDraft(tenantId, id);
}

/**
 * The sample is complete: its chunks become the draft's sample (a sample
 * uploaded before goes) and the analysis in auto mode starts.
 */
export async function completeSampleUpload(tenantId: string, id: string, uploadId: string): Promise<SpecDraftView> {
  const row = await getDraftRow(tenantId, id);
  const { upload, parts } = await claimCompletedUpload(tenantId, { specDraftId: id }, uploadId);
  const previous = row.storageParts;
  await touch(row.id, { storageParts: parts, fileName: upload.fileName, bytes: upload.bytes });
  await releaseUpload(uploadId);
  for (const ref of previous) await removeFile(tenantId, UPLOAD_CHUNK_BUCKET, ref).catch(() => undefined);
  return startAnalysis(tenantId, id);
}

const jobOptions = (row: SpecDraftSelect) => ({ max_episodes: row.sampleSize, contact_sheets: true, sheets_for_all: true });

/**
 * Let the critics look at X episodes of the sample in auto mode: they
 * generate the spec from the data and judge the sample with it. The generated
 * spec stays with the job (it is not stored as "<dataset>-auto"); the draft
 * takes it over when the run is done. Run again after X or the purpose
 * changed, the spec drafted so far is kept.
 */
export async function startAnalysis(tenantId: string, id: string): Promise<SpecDraftView> {
  const row = await getDraftRow(tenantId, id);
  if (!row.storageParts.length) throw new ConflictError("Upload a sample dataset first");
  const links = await datasetLinks(tenantId, { storageRef: null, storageParts: row.storageParts });
  const job = await criticsClient.createJob(links, null, jobOptions(row), purposeOf(row.purpose), false);
  await dropJobs([row.analysisJobId, row.testJobId]);
  await touch(row.id, {
    analysisJobId: job.job_id,
    analysisStatus: "queued",
    analysisError: null,
    analysisReport: null,
    testJobId: null,
    testStatus: "none",
    testError: null,
    testReport: null,
    step: row.spec ? row.step : "analysis",
  });
  return getSpecDraft(tenantId, id);
}

/**
 * The test run: the drafted spec over the same episodes of the sample (the
 * sample is drawn the same way every time), so the person sees what the spec
 * decides before it is stored.
 */
export async function startTest(tenantId: string, id: string, input: unknown): Promise<SpecDraftView> {
  const body = v.parse(v.object({ spec: v.optional(specObject) }), input ?? {});
  let row = await getDraftRow(tenantId, id);
  if (body.spec) row = await touch(row.id, { spec: body.spec });
  if (!row.storageParts.length) throw new ConflictError("Upload a sample dataset first");
  const spec = row.spec;
  const task = spec?.task as { instruction?: unknown } | undefined;
  if (!spec || typeof task?.instruction !== "string" || !task.instruction.trim()) {
    throw new InvalidInputError("The spec needs a task with an instruction (task.instruction)");
  }
  const links = await datasetLinks(tenantId, { storageRef: null, storageParts: row.storageParts });
  const job = await criticsClient.createJob(links, { ...spec, name: row.name || "draft" }, jobOptions(row), purposeOf(row.purpose));
  await dropJobs([row.testJobId]);
  await touch(row.id, { testJobId: job.job_id, testStatus: "queued", testError: null, testReport: null });
  return getSpecDraft(tenantId, id);
}

/**
 * The spec the critics generated, trimmed to what a person decides: the task
 * as it was read from the data, the robot type and the active arm, the
 * technical checks as they ran and the thresholds. The success indicators are
 * left out on purpose: the defaults are worded from the objects of the task,
 * which the person names in the wizard, and the wizard words them afresh from
 * those. What is left out the critics fill in with their defaults.
 */
export function seedSpec(report: DatasetReport, name: string): Record<string, unknown> {
  const spec = report.spec ?? {};
  const task = (spec.task ?? {}) as Record<string, unknown>;
  const robot = (spec.robot ?? {}) as Record<string, unknown>;
  const scoring = (spec.scoring ?? {}) as Record<string, unknown>;
  const seeded: Record<string, unknown> = {
    name: name || String(spec.name ?? "draft"),
    task: Object.fromEntries(
      Object.entries({
        instruction: task.instruction,
        scene: task.scene || undefined,
        objects: Array.isArray(task.objects) && task.objects.length ? task.objects : undefined,
        expected_cycles: task.expected_cycles ?? undefined,
        per_episode: task.per_episode && task.per_episode !== "auto" ? task.per_episode : undefined,
        notes: task.notes || undefined,
      }).filter(([, value]) => value !== undefined),
    ),
    robot: Object.fromEntries(
      Object.entries({
        type: robot.type || report.robot_type || undefined,
        active_arms: Array.isArray(robot.active_arms) && robot.active_arms.length ? robot.active_arms : undefined,
        primary_camera: robot.primary_camera || undefined,
      }).filter(([, value]) => value !== undefined),
    ),
  };
  if (Array.isArray(spec.hard_critics) && spec.hard_critics.length) seeded.hard_critics = spec.hard_critics;
  const thresholds = Object.fromEntries(
    Object.entries({ accept_threshold: scoring.accept_threshold, review_threshold: scoring.review_threshold }).filter(([, value]) => typeof value === "number"),
  );
  if (Object.keys(thresholds).length) seeded.scoring = thresholds;
  return seeded;
}

/** Mirror one run of a draft with its critics job. */
async function syncRun(
  row: SpecDraftSelect,
  run: SpecDraftRun,
): Promise<{ row: SpecDraftSelect; progress: Record<string, { done: number; total: number }> }> {
  const jobId = run === "analysis" ? row.analysisJobId : row.testJobId;
  const status = run === "analysis" ? row.analysisStatus : row.testStatus;
  if (!OPEN.includes(status) || !jobId) return { row, progress: {} };
  const fail = async (message: string) => ({
    row: await touch(row.id, run === "analysis" ? { analysisStatus: "failed", analysisError: message } : { testStatus: "failed", testError: message }),
    progress: {},
  });

  let job: CriticsJob;
  try {
    job = await criticsClient.job(jobId);
  } catch (error) {
    if (error instanceof CriticsError && error.status === 404) return fail("The critics job disappeared");
    log.error(`gym: critics job ${jobId} of spec draft ${row.id} could not be read: ${error instanceof Error ? error.message : String(error)}`);
    return { row, progress: {} };
  }
  if (job.status === "failed") return fail(job.error ?? "The critics run failed");
  if (job.status !== "done") {
    const next: SpecDraftRunStatus = job.status === "queued" ? "queued" : "running";
    const updated = next === status ? row : await touch(row.id, run === "analysis" ? { analysisStatus: next } : { testStatus: next });
    return { row: updated, progress: job.progress ?? {} };
  }
  const report = await criticsClient.report(jobId);
  if (run === "test") return { row: await touch(row.id, { testStatus: "done", testReport: report }), progress: {} };
  return {
    row: await touch(row.id, {
      analysisStatus: "done",
      analysisReport: report,
      // the generated spec is the starting point, unless the person is past it already
      ...(row.spec ? {} : { spec: seedSpec(report, row.name) }),
      ...(row.step === "analysis" || row.step === "sample" ? { step: "analysis" as const } : {}),
    }),
    progress: {},
  };
}

/** The report of a run of the draft (the analysis or the test), as the critics wrote it. */
export async function getSpecDraftReport(tenantId: string, id: string, run: SpecDraftRun): Promise<DatasetReport> {
  const row = await getDraftRow(tenantId, id);
  const report = run === "analysis" ? row.analysisReport : row.testReport;
  if (!report) throw new NotFoundError("Report");
  return report;
}

/** The job of a run, for its artifacts (the contact sheets of the sample). */
export async function specDraftJob(tenantId: string, id: string, run: SpecDraftRun): Promise<string> {
  const row = await getDraftRow(tenantId, id);
  const jobId = run === "analysis" ? row.analysisJobId : row.testJobId;
  if (!jobId) throw new NotFoundError("Critics run");
  return jobId;
}

/**
 * Store the spec in the critics service under `name`, name it on the skill,
 * and let the sample go. The draft is gone afterwards; the spec is what stays.
 */
export async function finishSpecDraft(
  tenantId: string,
  actor: Actor,
  id: string,
  input: unknown,
): Promise<{ name: string; skillId: string | null; assigned: boolean }> {
  const data = v.parse(finishSpecDraftSchema, input);
  const row = await getDraftRow(tenantId, id);
  if (!row.spec) throw new ConflictError("There is no spec to store yet: the analysis of the sample has to finish first");
  const name = specNameOf(data.name);
  if (!name) throw new InvalidInputError("The spec needs a name");
  if (!data.overwrite && (await specExists(name))) throw new ConflictError(`A spec named "${name}" exists already`);

  const stored = await saveSpecObject(name, { ...row.spec, name });
  const assigned = !!row.skillId && data.assignToSkill;
  if (assigned) {
    await getDb()
      .update(skills)
      .set({ criticSpecName: stored.name, updatedAt: new Date().toISOString() })
      .where(and(eq(skills.id, row.skillId!), eq(skills.tenantId, tenantId)));
  }
  await recordAudit(tenantId, { skillId: row.skillId }, actor, "spec.created", {
    name: stored.name,
    assignedToSkill: assigned,
    sample: row.fileName,
    sampleSize: row.sampleSize,
    purpose: row.purpose,
  });
  await removeDraft(row);
  return { name: stored.name, skillId: row.skillId, assigned };
}

/** Give up a draft: the sample, the critics jobs and the draft go, nothing is stored. */
export async function deleteSpecDraft(tenantId: string, id: string): Promise<void> {
  await removeDraft(await getDraftRow(tenantId, id));
}

/** The critics jobs hold a working copy of the sample; they go with the draft. */
async function dropJobs(jobIds: (string | null)[]): Promise<void> {
  for (const jobId of jobIds) if (jobId) await criticsClient.deleteJob(jobId);
}

/**
 * Remove a draft and everything temporary of it: the bytes of the sample and
 * of an upload still open, then the critics jobs, then the row. The bytes go
 * first because the rows are the only record of where they lie.
 */
async function removeDraft(row: SpecDraftSelect): Promise<void> {
  for (const ref of row.storageParts) await removeFile(row.tenantId, UPLOAD_CHUNK_BUCKET, ref).catch(() => undefined);
  const uploads = await getDb().select({ id: datasetUploads.id }).from(datasetUploads).where(eq(datasetUploads.specDraftId, row.id));
  await dropChunkFiles(uploads.map((u) => u.id));
  await dropJobs([row.analysisJobId, row.testJobId]);
  await getDb().delete(specDrafts).where(eq(specDrafts.id, row.id));
}

/** Drafts nobody came back to: run with the cleanup of abandoned uploads. */
export async function cleanupStaleSpecDrafts(): Promise<number> {
  const cutoff = new Date(Date.now() - STALE_AFTER_DAYS * 24 * 3600 * 1000).toISOString();
  const stale = await getDb().select().from(specDrafts).where(lt(specDrafts.updatedAt, cutoff));
  for (const row of stale) await removeDraft(row);
  if (stale.length) log.info(`gym: removed ${stale.length} abandoned spec draft(s) with their samples`);
  return stale.length;
}
