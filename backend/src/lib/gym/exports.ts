/**
 * Episode selection and export of a skill.
 *
 * The operator sees every episode of every recording dataset of the skill in
 * one table with the critics' verdict. The rollouts of the skill's evaluation
 * blocks are never part of it: they test a policy, they do not train one. Rejected episodes start deselected; the
 * operator can change any decision. "Download" saves the decision on the
 * episodes and as an export record, and builds a zip:
 *
 *   manifest.json                the selection: per source dataset the critics dataset name,
 *                                the job id and the selected episode indexes (also as ranges)
 *   <dataset>/selection.json     the critics' selection.json of that run
 *   <dataset>/summary.json       GYM's compact summary of that run
 *
 * The training pipeline takes the episode indexes per dataset from the
 * manifest (LeRobot: `--dataset.episodes`); the data itself stays where the
 * recording tool and the critics service keep it.
 *
 * That is the light export. The other one is the **merged dataset**: the same
 * selection, but as one LeRobot dataset that goes straight into training,
 * episodes renumbered without gaps and the task tables joined. The merging
 * itself happens in the critics service, which knows the LeRobot layout; GYM
 * hands it a temporary link to each stored dataset and streams the zip through.
 */
import { and, asc, eq, inArray } from "drizzle-orm";
import { strToU8, zipSync } from "fflate";
import * as v from "valibot";
import { getDb } from "@framework/lib/db/db-connection";
import { blocks, cells, datasets, dayProtocols, episodes, exports, HUMAN_VERDICTS, type DatasetSelect, type EpisodeSelect, type ExportSelect, type ExportSelection } from "../../db/schema";
import { recordAudit, type Actor } from "./audit";
import { datasetLinks, isDatasetStored } from "./datasets";
import { effectiveVerdict } from "./evaluations";
import { criticsClient } from "../critics/client";
import { upgradeStaleSummariesOf } from "../critics/sync";
import { InvalidInputError, NotFoundError, UpstreamError } from "./errors";
import { getSkillRow } from "./skills";
import { utcRows } from "./time";

/**
 * A dataset as the selection lists it. The selection is the skill's, over all
 * its recording blocks, so every dataset says which day and cell it came from.
 */
export type SelectionDatasetInfo = Pick<DatasetSelect, "id" | "name" | "dayProtocolId" | "blockId" | "episodeCount" | "createdAt" | "analysisStatus" | "analysis" | "storageRef" | "storageParts" | "criticsDatasetName" | "criticsJobId" | "selection"> & {
  date: string;
  cellName: string;
};

export interface SelectionDataset {
  dataset: SelectionDatasetInfo;
  episodes: EpisodeSelect[];
}

export interface SelectionTotals {
  episodes: number;
  accepted: number;
  review: number;
  rejected: number;
  selected: number;
}

export interface SelectionView {
  skillId: string;
  datasets: SelectionDataset[];
  totals: SelectionTotals;
}

export function totalsOf(rows: Pick<EpisodeSelect, "verdict" | "humanVerdict" | "selected">[]): SelectionTotals {
  return {
    episodes: rows.length,
    accepted: rows.filter((e) => effectiveVerdict(e) === "accept").length,
    review: rows.filter((e) => effectiveVerdict(e) === "review").length,
    rejected: rows.filter((e) => effectiveVerdict(e) === "reject").length,
    selected: rows.filter((e) => e.selected).length,
  };
}

export async function getSelection(tenantId: string, skillId: string): Promise<SelectionView> {
  await getSkillRow(tenantId, skillId);
  const ids = await getDb().select({ id: datasets.id }).from(datasets).where(and(eq(datasets.skillId, skillId), eq(datasets.tenantId, tenantId)));
  await upgradeStaleSummariesOf(ids.map((d) => d.id));
  const dsRows = await getDb()
    .select({
      id: datasets.id,
      name: datasets.name,
      dayProtocolId: datasets.dayProtocolId,
      blockId: datasets.blockId,
      episodeCount: datasets.episodeCount,
      createdAt: datasets.createdAt,
      analysisStatus: datasets.analysisStatus,
      analysis: datasets.analysis,
      storageRef: datasets.storageRef,
      storageParts: datasets.storageParts,
      criticsDatasetName: datasets.criticsDatasetName,
      criticsJobId: datasets.criticsJobId,
      selection: datasets.selection,
      date: dayProtocols.date,
      cellName: cells.name,
    })
    .from(datasets)
    .innerJoin(blocks, eq(blocks.id, datasets.blockId))
    .innerJoin(dayProtocols, eq(dayProtocols.id, datasets.dayProtocolId))
    .innerJoin(cells, eq(cells.id, dayProtocols.cellId))
    .where(and(eq(datasets.skillId, skillId), eq(datasets.tenantId, tenantId), eq(blocks.kind, "recording")))
    .orderBy(asc(datasets.createdAt));
  const epRows = dsRows.length
    ? await getDb()
        .select()
        .from(episodes)
        .where(inArray(episodes.datasetId, dsRows.map((d) => d.id)))
        .orderBy(asc(episodes.index))
    : [];
  return {
    skillId,
    datasets: dsRows.map((d) => ({ dataset: d, episodes: epRows.filter((e) => e.datasetId === d.id) })),
    totals: totalsOf(epRows),
  };
}

export const selectionChangesSchema = v.object({
  changes: v.pipe(
    v.array(
      v.object({
        episodeId: v.pipe(v.string(), v.uuid()),
        /** in the export or not */
        selected: v.optional(v.boolean()),
        /** the operator's word over the critics' verdict: accept or reject; null gives it back to the critics */
        humanVerdict: v.optional(v.nullable(v.picklist(HUMAN_VERDICTS))),
      }),
    ),
    v.maxLength(20000),
  ),
});

/**
 * Save the operator's decisions. Only episodes of the skill's recording
 * datasets can change. A human verdict overrules the critics on the episode
 * (the critics' verdict itself stays as it is) and, unless the same change
 * says otherwise, takes the episode in (accept) or out (reject) of the
 * export, the way a critics' reject starts deselected.
 */
export async function updateSelection(tenantId: string, actor: Actor, skillId: string, input: unknown): Promise<SelectionView> {
  const { changes } = v.parse(selectionChangesSchema, input);
  const current = await getSelection(tenantId, skillId);
  const allowed = new Set(current.datasets.flatMap((d) => d.episodes.map((e) => e.id)));
  const own = changes.filter((c) => allowed.has(c.episodeId));
  const selectedOf = (c: (typeof own)[number]) => c.selected ?? (c.humanVerdict ? c.humanVerdict === "accept" : undefined);
  const on = own.filter((c) => selectedOf(c) === true).map((c) => c.episodeId);
  const off = own.filter((c) => selectedOf(c) === false).map((c) => c.episodeId);
  const verdicts = own.filter((c) => c.humanVerdict !== undefined);
  if (on.length) await getDb().update(episodes).set({ selected: true }).where(and(eq(episodes.skillId, skillId), inArray(episodes.id, on)));
  if (off.length) await getDb().update(episodes).set({ selected: false }).where(and(eq(episodes.skillId, skillId), inArray(episodes.id, off)));
  const now = new Date().toISOString();
  for (const value of [...HUMAN_VERDICTS, null]) {
    const ids = verdicts.filter((c) => c.humanVerdict === value).map((c) => c.episodeId);
    if (!ids.length) continue;
    await getDb()
      .update(episodes)
      .set(value ? { humanVerdict: value, reviewedBy: actor.userId, reviewedByName: actor.userName, reviewedAt: now } : { humanVerdict: null, reviewedBy: null, reviewedByName: "", reviewedAt: null })
      .where(and(eq(episodes.skillId, skillId), inArray(episodes.id, ids)));
  }
  await recordAudit(tenantId, { skillId }, actor, verdicts.length ? "selection.verdicts" : "selection.updated", {
    selected: on.length,
    deselected: off.length,
    ...(verdicts.length
      ? {
          accepted: verdicts.filter((c) => c.humanVerdict === "accept").length,
          rejected: verdicts.filter((c) => c.humanVerdict === "reject").length,
          reset: verdicts.filter((c) => c.humanVerdict === null).length,
        }
      : {}),
  });
  return getSelection(tenantId, skillId);
}

export interface ExportResult {
  record: ExportSelect;
  zip: Uint8Array;
  fileName: string;
}

const safeName = (s: string) => s.replace(/[^\w.-]+/g, "_").replace(/^_+|_+$/g, "") || "dataset";

/** `[0,1,2,4,7,8]` → `"0-2,4,7-8"`, the form a `--episodes` filter takes (lerobot_critics.selection.compact_ranges). */
export function compactRanges(nums: number[]): string {
  const out: string[] = [];
  let start: number | null = null;
  let prev = 0;
  for (const n of [...new Set(nums)].sort((a, b) => a - b)) {
    if (start === null) {
      start = prev = n;
      continue;
    }
    if (n === prev + 1) {
      prev = n;
      continue;
    }
    out.push(start === prev ? String(start) : `${start}-${prev}`);
    start = prev = n;
  }
  if (start !== null) out.push(start === prev ? String(start) : `${start}-${prev}`);
  return out.join(",");
}

/** Build the export of the skill's selection and store the export record. */
export async function createExport(tenantId: string, actor: Actor, skillId: string, name?: string): Promise<ExportResult> {
  const skill = await getSkillRow(tenantId, skillId);
  const selection = await getSelection(tenantId, skillId);
  const selectedSets = selection.datasets
    .map((d) => ({ ...d, episodes: d.episodes.filter((e) => e.selected) }))
    .filter((d) => d.episodes.length);
  if (!selectedSets.length) throw new InvalidInputError("No episodes selected");

  const exportSelection: ExportSelection = {
    datasets: selectedSets.map((d) => ({
      datasetId: d.dataset.id,
      name: d.dataset.name,
      criticsDatasetName: d.dataset.criticsDatasetName,
      criticsJobId: d.dataset.criticsJobId,
      episodeIndexes: d.episodes.map((e) => e.index),
    })),
    episodes: selectedSets.reduce((a, d) => a + d.episodes.length, 0),
  };
  const exportName = (name?.trim() || `${skill.name} · export`).slice(0, 300);
  const [record] = await getDb()
    .insert(exports)
    .values({ tenantId, skillId, name: exportName, selection: exportSelection, createdBy: actor.userId })
    .returning();

  const zip = buildZip(skill.name, record!, selectedSets);
  await recordAudit(tenantId, { skillId }, actor, "export.created", { exportId: record!.id, episodes: exportSelection.episodes, datasets: exportSelection.datasets.length });
  return { record: record!, zip, fileName: `${safeName(skill.name)}-${record!.createdAt.slice(0, 10)}.zip` };
}

export async function listExports(tenantId: string, skillId: string): Promise<ExportSelect[]> {
  const rows = await getDb()
    .select()
    .from(exports)
    .where(and(eq(exports.skillId, skillId), eq(exports.tenantId, tenantId)))
    .orderBy(asc(exports.createdAt));
  return utcRows(rows);
}

export interface MergedExportResult {
  record: ExportSelect;
  /** the merged dataset as a zip, as the critics service built it */
  body: ReadableStream<Uint8Array> | null;
  fileName: string;
  episodes: number;
}

/**
 * The skill's selection as one merged LeRobot dataset, ready for training.
 *
 * The selection is saved like any other export, so the download stays in the
 * skill's record, and the merge itself is asked of the critics service: it
 * has the uploaded datasets, it knows the LeRobot layout and it can renumber
 * the episodes. The zip is streamed through, never held in memory here.
 *
 * A run whose dataset the critics service no longer has, or datasets that do
 * not fit together (other fps, other features), come back as an error from
 * there and are relayed as they are: the operator has to see which upload is
 * the odd one out.
 */
export async function createMergedExport(tenantId: string, actor: Actor, skillId: string, name?: string): Promise<MergedExportResult> {
  const skill = await getSkillRow(tenantId, skillId);
  const selection = await getSelection(tenantId, skillId);
  const selectedSets = selection.datasets
    .map((d) => ({ ...d, episodes: d.episodes.filter((e) => e.selected) }))
    .filter((d) => d.episodes.length);
  if (!selectedSets.length) throw new InvalidInputError("No episodes selected");
  const missing = selectedSets.filter((d) => !isDatasetStored(d.dataset));
  if (missing.length) {
    throw new InvalidInputError(
      `The dataset "${missing[0]!.dataset.name}" was recorded before GYM kept the uploads, so it cannot be merged. Upload it again to include it.`,
    );
  }

  const exportSelection: ExportSelection = {
    datasets: selectedSets.map((d) => ({
      datasetId: d.dataset.id,
      name: d.dataset.name,
      criticsDatasetName: d.dataset.criticsDatasetName,
      criticsJobId: d.dataset.criticsJobId,
      episodeIndexes: d.episodes.map((e) => e.index),
    })),
    episodes: selectedSets.reduce((a, d) => a + d.episodes.length, 0),
  };
  const exportName = (name?.trim() || `${skill.name} · dataset`).slice(0, 300);
  const [record] = await getDb()
    .insert(exports)
    .values({ tenantId, skillId, name: exportName, selection: exportSelection, createdBy: actor.userId })
    .returning();

  const datasetName = `${safeName(skill.name)}-${record!.createdAt.slice(0, 10)}`;
  // one fresh link per dataset: the critics fetch them for this one merge and
  // keep nothing, so a link is only ever as old as the request
  const sources = await Promise.all(
    selectedSets.map(async (d) => ({
      ...(await datasetLinks(tenantId, d.dataset)),
      episodes: d.episodes.map((e) => e.index),
      // a link carries a token, not a name: this is what the merged dataset's
      // manifest shows and what an error from the critics names
      name: d.dataset.criticsDatasetName,
    })),
  );
  const response = await criticsClient.merge({ name: datasetName, sources });
  if (!response.body) throw new UpstreamError("The data critics returned an empty merged dataset");
  await recordAudit(tenantId, { skillId }, actor, "export.merged", {
    exportId: record!.id,
    episodes: exportSelection.episodes,
    datasets: exportSelection.datasets.length,
  });
  return { record: record!, body: response.body, fileName: `${datasetName}.zip`, episodes: exportSelection.episodes };
}

/** Rebuild the zip of an earlier export from its stored selection. */
export async function getExportZip(tenantId: string, exportId: string): Promise<ExportResult> {
  const rows = await getDb()
    .select()
    .from(exports)
    .where(and(eq(exports.id, exportId), eq(exports.tenantId, tenantId)))
    .limit(1);
  const record = rows[0];
  if (!record) throw new NotFoundError("Export");
  const skill = await getSkillRow(tenantId, record.skillId);
  const selection = await getSelection(tenantId, record.skillId);
  const wanted = new Map(record.selection.datasets.map((d) => [d.datasetId, new Set(d.episodeIndexes)]));
  const sets = selection.datasets
    .filter((d) => wanted.has(d.dataset.id))
    .map((d) => ({ ...d, episodes: d.episodes.filter((e) => wanted.get(d.dataset.id)!.has(e.index)) }))
    .filter((d) => d.episodes.length);
  return { record, zip: buildZip(skill.name, record, sets), fileName: `${safeName(skill.name)}-${record.createdAt.slice(0, 10)}.zip` };
}

export function buildZip(skillName: string, record: ExportSelect, sets: SelectionDataset[]): Uint8Array {
  const files: Record<string, Uint8Array> = {};
  const manifest = {
    skill: skillName,
    export: { id: record.id, name: record.name, createdAt: record.createdAt },
    episodes: sets.reduce((a, s) => a + s.episodes.length, 0),
    datasets: sets.map((s) => ({
      name: s.dataset.name,
      criticsDataset: s.dataset.criticsDatasetName,
      criticsJob: s.dataset.criticsJobId,
      spec: s.dataset.analysis?.specName ?? null,
      episodes: s.episodes.map((e) => e.index),
      ranges: compactRanges(s.episodes.map((e) => e.index)),
      // the effective verdict; where a person overruled the critics, the critics' word is kept beside it
      verdicts: Object.fromEntries(s.episodes.map((e) => [e.index, effectiveVerdict(e)])),
      criticsVerdicts: Object.fromEntries(s.episodes.filter((e) => e.humanVerdict).map((e) => [e.index, e.verdict])),
    })),
  };
  files["manifest.json"] = strToU8(JSON.stringify(manifest, null, 2));
  for (const s of sets) {
    const dir = safeName(s.dataset.name);
    if (s.dataset.selection) files[`${dir}/selection.json`] = strToU8(JSON.stringify(s.dataset.selection, null, 1));
    if (s.dataset.analysis) files[`${dir}/summary.json`] = strToU8(JSON.stringify(s.dataset.analysis, null, 1));
  }
  return zipSync(files, { level: 6 });
}
