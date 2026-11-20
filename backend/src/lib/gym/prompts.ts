/**
 * The prompts of a skill's episodes: corrections and paraphrases.
 *
 * An episode carries the prompt it was recorded with (`episodes.task`, as the
 * critics read it). A dataset recorded under a stand-in prompt, or with a
 * prompt that does not match what was picked, is put right here without ever
 * rewriting the upload: a person sets a prompt per episode
 * (`episodes.prompt_override`) and the merged export writes it.
 *
 * Whether a prompt fits is not GYM's to judge. The prompt check hands the
 * episodes of one dataset and the episodes of the skill's other recording
 * datasets (with the prompts they count with now) to the data critics
 * (`POST /analyses/prompts`), which place every episode by the appearance of
 * what it picked and answer ok, propose (with the prompt that fits), review
 * or, without two prompts to learn from, a group per episode for a person to
 * name. GYM shows that answer and saves what the person decides.
 *
 * Paraphrases (augmentation) are the skill's: per prompt a list of variants,
 * spread evenly over the episodes that carry the prompt in a merged export, in
 * the order of the selection. That is counting, not judging.
 */
import { and, asc, eq, inArray, ne } from "drizzle-orm";
import * as v from "valibot";
import { getDb } from "@framework/lib/db/db-connection";
import { blocks, datasets, episodes, skills, type EpisodeSelect, type PromptVariants } from "../../db/schema";
import { criticsClient, type AnalysisEpisode, type DatasetReport, type PromptCheck, type PromptCheckRow } from "../critics/client";
import { recordAudit, type Actor } from "./audit";
import { getDatasetRow } from "./datasets";
import { effectiveVerdict } from "./evaluations";
import { InvalidInputError } from "./errors";
import { columnOf } from "./run-sheet";
import { getSkillRow } from "./skills";

/** The prompt an episode counts with: the one a person set, otherwise the recorded one. */
export const effectivePrompt = (e: Pick<EpisodeSelect, "task" | "promptOverride">): string => e.promptOverride ?? e.task;

/** The metrics of an episode's `diversity` result in a mirrored report; empty without one. */
export function diversityMetricsOf(report: DatasetReport | null | undefined, index: number): Record<string, unknown> {
  const ep = report?.episodes?.find((e) => e.episode === index);
  const result = ep?.hard?.find((c) => c.id === "diversity");
  return (result?.metrics as Record<string, unknown> | undefined) ?? {};
}

/** Does a report carry the features the shortcut figures and the prompt check read? */
export const hasCueFeatures = (metrics: Record<string, unknown>): boolean => typeof metrics.cue_features === "object" && metrics.cue_features !== null;

/**
 * The prompt every row ends up with when the skill's paraphrases are spread
 * over them: per prompt the rows that carry it take the variants in turn, in
 * the order given. With `keepOriginal` the prompt itself is the first variant.
 * A prompt without variants stays as it is.
 */
export function assignVariants(rows: { key: string; prompt: string }[], variants: PromptVariants): Map<string, string> {
  const turn = new Map<string, number>();
  const out = new Map<string, string>();
  for (const row of rows) {
    const spec = variants[row.prompt];
    const list = spec ? [...(spec.keepOriginal ? [row.prompt] : []), ...spec.variants] : [];
    if (!list.length) {
      out.set(row.key, row.prompt);
      continue;
    }
    const i = turn.get(row.prompt) ?? 0;
    turn.set(row.prompt, i + 1);
    out.set(row.key, list[i % list.length]!);
  }
  return out;
}

/**
 * Per dataset the prompts a merged export writes: episode index → prompt, only
 * where it differs from the recorded one. `withVariants` false applies the
 * corrections alone (the unfiltered download of one dataset).
 */
export function exportPromptsOf(
  sets: { dataset: { id: string }; episodes: Pick<EpisodeSelect, "index" | "task" | "promptOverride">[] }[],
  variants: PromptVariants,
  withVariants = true,
): Map<string, Record<string, string>> {
  const rows = sets.flatMap((d) => d.episodes.map((e) => ({ key: `${d.dataset.id}:${e.index}`, prompt: effectivePrompt(e), datasetId: d.dataset.id, e })));
  const assigned = withVariants ? assignVariants(rows, variants) : new Map(rows.map((r) => [r.key, r.prompt]));
  const out = new Map<string, Record<string, string>>();
  for (const r of rows) {
    const prompt = assigned.get(r.key) ?? r.prompt;
    if (!prompt || prompt === r.e.task) continue;
    const own = out.get(r.datasetId) ?? {};
    own[String(r.e.index)] = prompt;
    out.set(r.datasetId, own);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------

export interface PromptCheckEpisode {
  episodeId: string;
  index: number;
  /** recorded */
  task: string;
  /** set by a person, null = the recorded one stands */
  promptOverride: string | null;
  /** what it counts with now */
  prompt: string;
  status: PromptCheckRow["status"] | "not_analysed";
  proposed: string | null;
  confidence: number | null;
  votes: Record<string, number>;
  group: number | null;
  reason: PromptCheckRow["reason"] | null;
}

export interface PromptCheckView {
  datasetId: string;
  datasetName: string;
  skillId: string;
  /** null when no episode of the dataset carries the features (an older run): nothing could be checked */
  mode: PromptCheck["mode"] | null;
  /** every prompt the skill knows: the episodes' own, the run sheet's, the paraphrased ones */
  candidates: string[];
  /** reference episodes per prompt */
  referencePrompts: Record<string, number>;
  confusable: { prompts: string[]; rate: number }[];
  episodes: PromptCheckEpisode[];
  counts: Record<string, number>;
  /** the skill's paraphrases */
  variants: PromptVariants;
  /** selected episodes per prompt over the skill's selection: what the variants are spread over */
  selectionCounts: Record<string, number>;
}

/** Every prompt the skill knows by name, for the person to pick from. */
async function candidatePrompts(skill: { strategy: { runSheet: { columns: string[]; rows: Record<string, string>[] } | null } | null; promptVariants: PromptVariants }, known: string[]): Promise<string[]> {
  const out = new Set(known.filter(Boolean));
  for (const p of Object.keys(skill.promptVariants ?? {})) out.add(p);
  const sheet = skill.strategy?.runSheet;
  const column = sheet ? columnOf(sheet, "prompt") : null;
  if (sheet && column) for (const row of sheet.rows) if (row[column]?.trim()) out.add(row[column]!.trim());
  return [...out].sort();
}

/**
 * The prompt check of one dataset: its episodes against the skill's other
 * recording datasets, judged by the critics. The reference leaves out what a
 * person or the critics rejected; a rejected episode is often a failed grasp.
 */
export async function getPromptCheck(tenantId: string, datasetId: string): Promise<PromptCheckView> {
  const ds = await getDatasetRow(tenantId, datasetId);
  const skill = await getSkillRow(tenantId, ds.skillId);
  const own = await getDb()
    .select()
    .from(episodes)
    .where(and(eq(episodes.tenantId, tenantId), eq(episodes.datasetId, datasetId)))
    .orderBy(asc(episodes.index));
  const others = await getDb()
    .select({ id: datasets.id, report: datasets.report })
    .from(datasets)
    .innerJoin(blocks, eq(blocks.id, datasets.blockId))
    .where(and(eq(datasets.tenantId, tenantId), eq(datasets.skillId, ds.skillId), ne(datasets.id, datasetId), eq(blocks.kind, "recording")));
  const otherEpisodes = others.length
    ? await getDb()
        .select()
        .from(episodes)
        .where(and(eq(episodes.tenantId, tenantId), inArray(episodes.datasetId, others.map((o) => o.id))))
        .orderBy(asc(episodes.index))
    : [];
  const reportOf = new Map(others.map((o) => [o.id, o.report]));

  const wire = (e: EpisodeSelect, report: DatasetReport | null | undefined): AnalysisEpisode => ({
    id: e.id,
    dataset: e.datasetId,
    order: e.index,
    prompt: effectivePrompt(e) || null,
    metrics: diversityMetricsOf(report, e.index),
  });
  const targets = own.map((e) => wire(e, ds.report));
  const reference = otherEpisodes
    .filter((e) => effectiveVerdict(e) !== "reject")
    .map((e) => wire(e, reportOf.get(e.datasetId)))
    .filter((e) => hasCueFeatures(e.metrics));
  const candidates = await candidatePrompts(skill, [...own, ...otherEpisodes].map(effectivePrompt));

  let check: PromptCheck | null = null;
  if (targets.some((t) => hasCueFeatures(t.metrics))) {
    check = await criticsClient.analysePrompts({ episodes: targets, reference, candidates });
  }
  const rowOf = new Map((check?.episodes ?? []).map((r) => [r.id, r]));
  const rows = own.map((e): PromptCheckEpisode => {
    const r = rowOf.get(e.id);
    return {
      episodeId: e.id,
      index: e.index,
      task: e.task,
      promptOverride: e.promptOverride,
      prompt: effectivePrompt(e),
      status: r?.status ?? "not_analysed",
      proposed: r?.proposed ?? null,
      confidence: r?.confidence ?? null,
      votes: r?.votes ?? {},
      group: r?.group ?? null,
      reason: r?.reason ?? null,
    };
  });
  const counts: Record<string, number> = {};
  for (const r of rows) counts[r.status] = (counts[r.status] ?? 0) + 1;
  return {
    datasetId,
    datasetName: ds.name,
    skillId: ds.skillId,
    mode: check?.mode ?? null,
    candidates: [...new Set([...candidates, ...(check?.candidates ?? [])])].sort(),
    referencePrompts: check?.prompts ?? {},
    confusable: check?.confusable ?? [],
    episodes: rows,
    counts,
    variants: skill.promptVariants ?? {},
    selectionCounts: await selectionCounts(tenantId, ds.skillId),
  };
}

/** Selected episodes per prompt over the skill's recording datasets that are part of the selection. */
async function selectionCounts(tenantId: string, skillId: string): Promise<Record<string, number>> {
  const rows = await getDb()
    .select({ task: episodes.task, promptOverride: episodes.promptOverride })
    .from(episodes)
    .innerJoin(datasets, eq(datasets.id, episodes.datasetId))
    .innerJoin(blocks, eq(blocks.id, datasets.blockId))
    .where(and(eq(episodes.tenantId, tenantId), eq(episodes.skillId, skillId), eq(episodes.selected, true), eq(datasets.included, true), eq(blocks.kind, "recording")));
  const out: Record<string, number> = {};
  for (const r of rows) {
    const p = effectivePrompt(r);
    out[p] = (out[p] ?? 0) + 1;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Saving
// ---------------------------------------------------------------------------

const promptText = v.pipe(v.string(), v.trim(), v.maxLength(500));

export const promptChangesSchema = v.object({
  episodes: v.pipe(
    v.array(
      v.object({
        index: v.pipe(v.number(), v.integer(), v.minValue(0)),
        /** the prompt to count with; null or empty gives the episode its recorded prompt back */
        prompt: v.nullable(promptText),
      }),
    ),
    v.maxLength(20000),
  ),
});

/** Set the prompt of episodes of one dataset. The upload and the recorded task stay as they are. */
export async function setPrompts(tenantId: string, actor: Actor, datasetId: string, input: unknown): Promise<{ changed: number }> {
  const { episodes: changes } = v.parse(promptChangesSchema, input);
  const ds = await getDatasetRow(tenantId, datasetId);
  const rows = await getDb()
    .select({ id: episodes.id, index: episodes.index, task: episodes.task, promptOverride: episodes.promptOverride })
    .from(episodes)
    .where(and(eq(episodes.tenantId, tenantId), eq(episodes.datasetId, datasetId)));
  const byIndex = new Map(rows.map((r) => [r.index, r]));
  const missing = changes.filter((c) => !byIndex.has(c.index)).map((c) => c.index);
  if (missing.length) throw new InvalidInputError(`The dataset has no episode ${missing.slice(0, 5).join(", ")}`);
  let changed = 0;
  const byPrompt = new Map<string | null, string[]>();
  for (const c of changes) {
    const row = byIndex.get(c.index)!;
    const next = c.prompt && c.prompt !== row.task ? c.prompt : null;
    if (next === row.promptOverride) continue;
    changed += 1;
    byPrompt.set(next, [...(byPrompt.get(next) ?? []), row.id]);
  }
  for (const [prompt, ids] of byPrompt) {
    await getDb().update(episodes).set({ promptOverride: prompt }).where(and(eq(episodes.tenantId, tenantId), inArray(episodes.id, ids)));
  }
  if (changed) {
    await recordAudit(tenantId, { skillId: ds.skillId, dayProtocolId: ds.dayProtocolId, blockId: ds.blockId }, actor, "dataset.prompts", {
      datasetId,
      changed,
      prompts: [...byPrompt.keys()].map((p) => p ?? "(recorded)"),
    });
  }
  return { changed };
}

export const promptVariantsSchema = v.pipe(
  v.record(
    v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(500)),
    v.object({
      variants: v.pipe(v.array(promptText), v.maxLength(50)),
      keepOriginal: v.boolean(),
    }),
  ),
  v.check((r) => Object.keys(r).length <= 200, "At most 200 prompts carry paraphrases"),
);

/** Replace the skill's paraphrases. A prompt whose list is empty and keeps its original is dropped. */
export async function setPromptVariants(tenantId: string, actor: Actor, skillId: string, input: unknown): Promise<PromptVariants> {
  const parsed = v.parse(promptVariantsSchema, input);
  await getSkillRow(tenantId, skillId);
  const clean: PromptVariants = {};
  for (const [prompt, spec] of Object.entries(parsed)) {
    const variants = [...new Set(spec.variants.filter((x) => x && x !== prompt))];
    if (!variants.length) continue;
    clean[prompt] = { variants, keepOriginal: spec.keepOriginal };
  }
  await getDb()
    .update(skills)
    .set({ promptVariants: clean, updatedAt: new Date().toISOString() })
    .where(and(eq(skills.tenantId, tenantId), eq(skills.id, skillId)));
  await recordAudit(tenantId, { skillId }, actor, "skill.prompt_variants", {
    prompts: Object.keys(clean).length,
    variants: Object.values(clean).reduce((a, s) => a + s.variants.length, 0),
  });
  return clean;
}
