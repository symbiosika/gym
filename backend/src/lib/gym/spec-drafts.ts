/**
 * Spec drafts: the spec wizard.
 *
 * Writing a critics spec by hand means knowing every field before seeing what
 * the critics make of the data. The wizard turns that around. A sample
 * dataset is uploaded for the time of the wizard, the critics run in auto
 * mode over X of its episodes (spread over the session) and generate a spec,
 * and the person walks through that spec: task, robot and cameras, then the
 * workbench, one live view of the sample with every episode's video and every
 * result of the critics next to the settings of the spec. An episode the
 * person knows by number is analysed on top of the sample (`addEpisode`), and
 * the person's own word on an episode (good or bad, `judgments`) is kept so
 * the workbench can show where the spec decides differently. A test run with
 * the drafted spec over the same episodes shows what it would decide before
 * it is stored.
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
import {
  datasetUploads,
  skills,
  SPEC_DRAFT_DEFAULT_EPISODES,
  SPEC_DRAFT_STEPS,
  specDrafts,
  type SpecDraftExtraRun,
  type SpecDraftRunStatus,
  type SpecDraftSelect,
  type SpecDraftStep,
} from "../../db/schema";
import { criticsClient, CriticsError, type CriticsJob, type DatasetReport } from "../critics/client";
import { saveSpecObject, specExists, specNameOf } from "../critics/specs";
import { removeFile } from "../storage";
import { recordAudit, type Actor } from "./audit";
import { UPLOAD_CHUNK_BUCKET } from "./buckets";
import { claimCompletedUpload, dropChunkFiles, releaseUpload } from "./dataset-uploads";
import { datasetLinks, purposeOf } from "./datasets";
import { formatEpisodeSelection, parseEpisodeSelection } from "./episode-selection";
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
  /** where the test runs stand: one going, else the latest one's outcome */
  testStatus: SpecDraftRunStatus;
  testError: string | null;
  /** the progress of a run that is still going, as the critics report it */
  analysisProgress: Record<string, { done: number; total: number }>;
  testProgress: Record<string, { done: number; total: number }>;
  /** the verdict counts of a finished run, for the overview */
  analysisCounts: Record<string, number> | null;
  testCounts: Record<string, number> | null;
};

/** a pick of episodes like print pages: "0-9", "1-3,6,8"; checked by parsing it */
const episodePick = v.pipe(
  v.string(),
  v.trim(),
  v.maxLength(2000),
  v.check((text) => {
    try {
      return parseEpisodeSelection(text).length > 0;
    } catch {
      return false;
    }
  }, 'Pick episodes like "0-9" or "1-3,6,8"'),
);
const purpose = v.picklist(["recording", "evaluation"] as const);
const specObject = v.record(v.string(), v.unknown());

export const createSpecDraftSchema = v.object({
  name: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(200)), ""),
  skillId: v.optional(v.nullable(v.pipe(v.string(), v.uuid())), null),
  purpose: v.optional(purpose, "recording"),
  episodes: v.optional(episodePick, SPEC_DRAFT_DEFAULT_EPISODES),
});

export const updateSpecDraftSchema = v.object({
  name: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(200))),
  skillId: v.optional(v.nullable(v.pipe(v.string(), v.uuid()))),
  purpose: v.optional(purpose),
  episodes: v.optional(episodePick),
  step: v.optional(v.picklist(SPEC_DRAFT_STEPS)),
  spec: v.optional(v.nullable(specObject)),
  /** the person's word per episode index; the whole map is replaced */
  judgments: v.optional(v.record(v.pipe(v.string(), v.regex(/^\d{1,7}$/)), v.picklist(["accept", "reject"] as const))),
});

export const addEpisodeSchema = v.union([
  v.object({ episodes: episodePick }),
  v.object({ episode: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(10_000_000)) }),
]);

export const testSchema = v.object({
  spec: v.optional(specObject),
  /** the episodes to test; without, those of the analysis */
  episodes: v.optional(episodePick),
});

/**
 * A short fingerprint of a spec, to say which spec an episode was tested
 * with. The frontend takes the same over the spec it saves
 * (frontend/src/utils/episodes.ts), so it can tell a test of the spec on
 * screen from one of an earlier state: FNV-1a over its JSON with the keys
 * sorted, as the database does not keep the order of a JSON document's keys.
 */
const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined);
    entries.sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
};

export function specFingerprint(spec: Record<string, unknown>): string {
  const text = canonicalJson(spec);
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

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
  const open = row.testRuns.find((r) => OPEN.includes(r.status));
  const latest = row.testRuns.at(-1);
  return {
    ...rest,
    step: currentStep(rest.step),
    skillName,
    testStatus: open?.status ?? latest?.status ?? "none",
    testError: !open && latest?.status === "failed" ? (latest.error ?? null) : null,
    analysisProgress: progress.analysis ?? {},
    testProgress: progress.test ?? {},
    analysisCounts: analysisReport?.counts ?? null,
    testCounts: testReport?.counts ?? null,
  };
};

/** Steps of earlier versions of the wizard (checks, success, scoring) are the workbench now. */
const currentStep = (step: string): SpecDraftStep =>
  (SPEC_DRAFT_STEPS as readonly string[]).includes(step) ? (step as SpecDraftStep) : "workbench";

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
      episodeSelection: formatEpisodeSelection(parseEpisodeSelection(data.episodes)),
      createdBy: actor.userId,
    })
    .returning();
  return toView(row!, skill?.name ?? null);
}

/** One draft, brought up to date with its critics runs. */
export async function getSpecDraft(tenantId: string, id: string): Promise<SpecDraftView> {
  let row = await getDraftRow(tenantId, id);
  const progress: Partial<Record<SpecDraftRun, Record<string, { done: number; total: number }>>> = {};
  const synced = await syncAnalysis(row);
  row = synced.row;
  progress.analysis = synced.progress;
  row = await syncExtraRuns(row);
  const tested = await syncTestRuns(row);
  row = tested.row;
  progress.test = tested.progress;
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
    ...(data.episodes !== undefined ? { episodeSelection: formatEpisodeSelection(parseEpisodeSelection(data.episodes)) } : {}),
    ...(data.step !== undefined ? { step: data.step } : {}),
    ...(data.spec !== undefined ? { spec: data.spec } : {}),
    ...(data.judgments !== undefined ? { judgments: data.judgments } : {}),
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

/** The episodes of the analysis: the pick, and those added in the workbench. */
const analysedEpisodes = (row: SpecDraftSelect): number[] =>
  [...new Set([...parseEpisodeSelection(row.episodeSelection), ...row.extraEpisodes])].sort((a, b) => a - b);

/** A run over these episodes, with a contact sheet of each. */
const jobOptions = (episodes: number[]) => ({ episodes, contact_sheets: true, sheets_for_all: true });

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
  const job = await criticsClient.createJob(links, null, jobOptions(analysedEpisodes(row)), purposeOf(row.purpose), false);
  // the episodes added in the workbench are part of this run: their own runs are done with
  await dropJobs([row.analysisJobId, ...row.testRuns.map((r) => r.jobId), ...row.extraRuns.map((r) => r.jobId)]);
  await touch(row.id, {
    extraRuns: [],
    analysisJobId: job.job_id,
    analysisStatus: "queued",
    analysisError: null,
    analysisReport: null,
    testRuns: [],
    testReport: null,
    testSpecs: {},
    step: row.spec ? row.step : "analysis",
  });
  return getSpecDraft(tenantId, id);
}

/**
 * A test run: the drafted spec over the episodes the person picks (one in
 * the workbench, a pick, or all those of the analysis), so the person sees
 * what the spec decides, the model's scores for reworded criteria included,
 * before it is stored. Runs go side by side; each one that finishes is merged
 * into the test report, and an episode keeps the result of its latest test
 * with the fingerprint of the spec it ran with.
 */
export async function startTest(tenantId: string, id: string, input: unknown): Promise<SpecDraftView> {
  const body = v.parse(testSchema, input ?? {});
  let row = await getDraftRow(tenantId, id);
  if (body.spec) row = await touch(row.id, { spec: body.spec });
  if (!row.storageParts.length) throw new ConflictError("Upload a sample dataset first");
  const spec = row.spec;
  const task = spec?.task as { instruction?: unknown } | undefined;
  if (!spec || typeof task?.instruction !== "string" || !task.instruction.trim()) {
    throw new InvalidInputError("The spec needs a task with an instruction (task.instruction)");
  }
  const episodes = body.episodes ? parseEpisodeSelection(body.episodes) : analysedEpisodes(row);
  const total = row.analysisReport?.dataset_episodes ?? null;
  if (total != null && episodes.some((e) => e >= total)) throw new InvalidInputError(`The dataset holds episodes 0 to ${total - 1}`);
  const links = await datasetLinks(tenantId, { storageRef: null, storageParts: row.storageParts });
  const job = await criticsClient.createJob(links, { ...spec, name: row.name || "draft" }, jobOptions(episodes), purposeOf(row.purpose));
  const run: SpecDraftExtraRun = {
    jobId: job.job_id,
    episodes,
    status: "queued",
    specHash: specFingerprint(spec),
    startedAt: new Date().toISOString(),
  };
  await touch(row.id, { testRuns: [...row.testRuns, run] });
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

/** Mirror the analysis of a draft with its critics job. */
async function syncAnalysis(row: SpecDraftSelect): Promise<{ row: SpecDraftSelect; progress: Record<string, { done: number; total: number }> }> {
  const jobId = row.analysisJobId;
  const status = row.analysisStatus;
  if (!OPEN.includes(status) || !jobId) return { row, progress: {} };
  const fail = async (message: string) => ({ row: await touch(row.id, { analysisStatus: "failed", analysisError: message }), progress: {} });

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
    const updated = next === status ? row : await touch(row.id, { analysisStatus: next });
    return { row: updated, progress: job.progress ?? {} };
  }
  const report = await criticsClient.report(jobId);
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

/**
 * Bring the test runs up to date: a finished one goes into the test report,
 * its episodes take the fingerprint of the spec it ran with. The progress
 * returned is that of the runs still going, added up.
 */
async function syncTestRuns(row: SpecDraftSelect): Promise<{ row: SpecDraftSelect; progress: Record<string, { done: number; total: number }> }> {
  if (!row.testRuns.some((r) => OPEN.includes(r.status))) return { row, progress: {} };
  let report = row.testReport;
  const specs = { ...row.testSpecs };
  const progress: Record<string, { done: number; total: number }> = {};
  const runs: SpecDraftExtraRun[] = [];
  for (const run of row.testRuns) {
    if (!OPEN.includes(run.status)) {
      runs.push(run);
      continue;
    }
    try {
      const job = await criticsClient.job(run.jobId);
      if (job.status === "failed") runs.push({ ...run, status: "failed", error: job.error ?? "The critics run failed" });
      else if (job.status !== "done") {
        runs.push({ ...run, status: job.status === "queued" ? "queued" : "running" });
        for (const [stage, p] of Object.entries(job.progress ?? {})) {
          const sum = (progress[stage] ??= { done: 0, total: 0 });
          sum.done += p.done;
          sum.total += p.total;
        }
      } else {
        const done = await criticsClient.report(run.jobId);
        report = report ? mergeReports(report, done, true) : done;
        for (const e of done.episodes) if (run.specHash) specs[String(e.episode)] = run.specHash;
        runs.push({ ...run, status: "done" });
      }
    } catch (error) {
      if (error instanceof CriticsError && error.status === 404) runs.push({ ...run, status: "failed", error: "The critics job disappeared" });
      else runs.push(run);
    }
  }
  return { row: await touch(row.id, { testRuns: runs, testReport: report, testSpecs: specs }), progress };
}

/**
 * Analyse one more episode of the sample dataset, one the person knows by
 * number: a small run with the spec the analysis ran with, merged into the
 * analysis report when it is done. Its outlier flags are missing, as they
 * compare an episode with the others of its run; the next full analysis
 * (`startAnalysis`) takes the episode in like any other.
 */
export async function addEpisode(tenantId: string, id: string, input: unknown): Promise<SpecDraftView> {
  const body = v.parse(addEpisodeSchema, input);
  const picked = "episodes" in body ? parseEpisodeSelection(body.episodes) : [body.episode];
  const row = await getDraftRow(tenantId, id);
  const report = row.analysisReport;
  if (!report || !row.analysisJobId) throw new ConflictError("The analysis of the sample has to finish first");
  const total = report.dataset_episodes ?? null;
  if (total != null && picked.some((e) => e >= total)) throw new InvalidInputError(`The dataset holds episodes 0 to ${total - 1}`);
  const known = new Set([
    ...report.episodes.map((e) => e.episode),
    ...row.extraRuns.filter((r) => r.status !== "failed").flatMap((r) => r.episodes),
  ]);
  const fresh = picked.filter((e) => !known.has(e));
  if (!fresh.length) return getSpecDraft(tenantId, id);
  const links = await datasetLinks(tenantId, { storageRef: null, storageParts: row.storageParts });
  const job = await criticsClient.createJob(links, { ...report.spec, name: report.spec_name || "draft" }, jobOptions(fresh), purposeOf(row.purpose));
  const run: SpecDraftExtraRun = { jobId: job.job_id, episodes: fresh, status: "queued" };
  await touch(row.id, {
    extraEpisodes: [...new Set([...row.extraEpisodes, ...fresh])].sort((a, b) => a - b),
    extraRuns: [...row.extraRuns.filter((r) => !r.episodes.some((e) => fresh.includes(e))), run],
  });
  return getSpecDraft(tenantId, id);
}

/**
 * The episodes of `extra` taken into `base`: an episode of both is replaced,
 * the rest sorted in, and the counts follow. What the critics wrote stays as
 * they wrote it; only the lists over the episodes are counted again.
 */
export function mergeReports(base: DatasetReport, extra: DatasetReport, newer = false): DatasetReport {
  const byIndex = new Map(base.episodes.map((e) => [e.episode, e]));
  for (const e of extra.episodes) byIndex.set(e.episode, e);
  const episodes = [...byIndex.values()].sort((a, b) => a.episode - b.episode);
  const by = (verdict: string) => episodes.filter((e) => e.score.verdict === verdict).map((e) => e.episode);
  const flagCounts: Record<string, number> = {};
  for (const e of episodes) for (const f of e.score.flags) flagCounts[f] = (flagCounts[f] ?? 0) + 1;
  const include = by("accept");
  const review = by("review");
  const exclude = by("reject");
  return {
    ...base,
    episodes,
    n_episodes: episodes.length,
    include,
    review,
    exclude,
    counts: { accept: include.length, review: review.length, reject: exclude.length },
    flag_counts: flagCounts,
    flag_docs: { ...(base.flag_docs ?? {}), ...(extra.flag_docs ?? {}) },
    // a test run carries the spec as it stands now: its wording is what the newer scores belong to
    ...(newer ? { spec: extra.spec, spec_name: extra.spec_name } : {}),
    metric_docs: { ...base.metric_docs, ...extra.metric_docs },
  };
}

/** Bring the runs over picked episodes up to date; a finished one goes into the analysis report. */
async function syncExtraRuns(row: SpecDraftSelect): Promise<SpecDraftSelect> {
  if (!row.extraRuns.some((r) => OPEN.includes(r.status))) return row;
  let report = row.analysisReport;
  const runs: SpecDraftExtraRun[] = [];
  for (const run of row.extraRuns) {
    if (!OPEN.includes(run.status)) {
      runs.push(run);
      continue;
    }
    try {
      const job = await criticsClient.job(run.jobId);
      if (job.status === "failed") runs.push({ ...run, status: "failed", error: job.error ?? "The critics run failed" });
      else if (job.status !== "done") runs.push({ ...run, status: job.status === "queued" ? "queued" : "running" });
      else {
        if (report) report = mergeReports(report, await criticsClient.report(run.jobId));
        runs.push({ ...run, status: "done" });
      }
    } catch (error) {
      if (error instanceof CriticsError && error.status === 404) runs.push({ ...run, status: "failed", error: "The critics job disappeared" });
      else runs.push(run);
    }
  }
  return touch(row.id, { extraRuns: runs, analysisReport: report });
}

/** The job that holds an episode of a run: for the test the latest test of it, else a run over added episodes, else the analysis. */
function jobOfEpisode(row: SpecDraftSelect, episode: number, run: SpecDraftRun = "analysis"): string {
  if (run === "test") {
    const tested = [...row.testRuns].reverse().find((r) => r.status === "done" && r.episodes.includes(episode));
    if (!tested) throw new NotFoundError("Test run");
    return tested.jobId;
  }
  const extra = row.extraRuns.find((r) => r.status === "done" && r.episodes.includes(episode));
  const jobId = extra?.jobId ?? row.analysisJobId;
  if (!jobId) throw new NotFoundError("Critics run");
  return jobId;
}

/** The camera videos of one episode of the sample, from the critics job that holds it. */
export async function episodeVideos(tenantId: string, id: string, episode: number) {
  const row = await getDraftRow(tenantId, id);
  return criticsClient.episodeVideos(jobOfEpisode(row, episode), episode);
}

/** One camera video of an episode of the sample, streamed; `range` lets the player seek. */
export async function episodeVideo(tenantId: string, id: string, episode: number, camera: string, range?: string | null): Promise<Response> {
  const row = await getDraftRow(tenantId, id);
  return criticsClient.episodeVideo(jobOfEpisode(row, episode), episode, camera, range);
}

/** The report of a run of the draft (the analysis or the test), as the critics wrote it. */
export async function getSpecDraftReport(tenantId: string, id: string, run: SpecDraftRun): Promise<DatasetReport> {
  const row = await getDraftRow(tenantId, id);
  const report = run === "analysis" ? row.analysisReport : row.testReport;
  if (!report) throw new NotFoundError("Report");
  return report;
}

/**
 * The job of a run, for its artifacts (the contact sheets of the sample). With
 * `episode`, the analysis job that holds that episode (one picked by number
 * has a run of its own).
 */
export async function specDraftJob(tenantId: string, id: string, run: SpecDraftRun, episode?: number): Promise<string> {
  const row = await getDraftRow(tenantId, id);
  if (episode != null) return jobOfEpisode(row, episode, run);
  const jobId = run === "analysis" ? row.analysisJobId : ([...row.testRuns].reverse().find((r) => r.status === "done")?.jobId ?? null);
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
    episodes: row.episodeSelection,
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
  await dropJobs([row.analysisJobId, ...row.testRuns.map((r) => r.jobId), ...row.extraRuns.map((r) => r.jobId)]);
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
