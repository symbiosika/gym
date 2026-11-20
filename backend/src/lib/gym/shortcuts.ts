/**
 * The shortcut figures over a skill's selection: what a policy could learn
 * instead of the prompt.
 *
 * GYM judges nothing here. The data critics measured every episode (their
 * `diversity` critic writes `cue_features`: start and end state, a picture of
 * the first frame, the colours of what was picked) and GYM mirrors that in the
 * report. For the figures over a selection GYM hands those metrics of the
 * selected episodes, with the prompt each counts with now, to the critics
 * (`POST /analyses/shortcuts`) and shows their answer as it is: whether the
 * background, the start pose or the grasp position tell the prompt or the arm
 * for scenes held out, how many scenes carry several prompts, and whether the
 * evaluation rollouts of the skill start where the recordings started.
 *
 * Rollouts are only ever the comparison: they never enter the selection.
 */
import { and, asc, eq, inArray } from "drizzle-orm";
import { getDb } from "@framework/lib/db/db-connection";
import { blocks, datasets, episodes } from "../../db/schema";
import { criticsClient, type AnalysisEpisode, type ShortcutAnalysis } from "../critics/client";
import { getSelection, selectedOf } from "./exports";
import { NotFoundError } from "./errors";
import { diversityMetricsOf, effectivePrompt, hasCueFeatures } from "./prompts";

export interface SelectionShortcuts {
  skillId: string;
  /** the figures are over this one dataset's selected episodes; null = the whole selection */
  datasetId: string | null;
  datasets: number;
  /** selected episodes the figures are taken over */
  episodes: number;
  /** among them, episodes whose report predates the features (analysed before this version): left out */
  withoutFeatures: number;
  /** rollouts of the skill's evaluation blocks whose start poses are compared */
  evaluationEpisodes: number;
  /** the critics' answer; null when no selected episode carries the features */
  analysis: ShortcutAnalysis | null;
}

export async function getSelectionShortcuts(tenantId: string, skillId: string, datasetId?: string | null): Promise<SelectionShortcuts> {
  const sets = selectedOf(await getSelection(tenantId, skillId)).filter((d) => !datasetId || d.dataset.id === datasetId);
  if (datasetId && !sets.length) {
    const [exists] = await getDb()
      .select({ id: datasets.id })
      .from(datasets)
      .where(and(eq(datasets.tenantId, tenantId), eq(datasets.skillId, skillId), eq(datasets.id, datasetId)));
    if (!exists) throw new NotFoundError("Dataset");
  }
  const ids = sets.map((d) => d.dataset.id);
  const reports = ids.length
    ? await getDb().select({ id: datasets.id, report: datasets.report }).from(datasets).where(and(eq(datasets.tenantId, tenantId), inArray(datasets.id, ids)))
    : [];
  const reportOf = new Map(reports.map((r) => [r.id, r.report]));

  const selected: AnalysisEpisode[] = sets.flatMap((d) =>
    d.episodes.map((e) => ({
      id: e.id,
      dataset: d.dataset.id,
      order: e.index,
      prompt: effectivePrompt(e) || null,
      metrics: diversityMetricsOf(reportOf.get(d.dataset.id), e.index),
    })),
  );
  const withFeatures = selected.filter((e) => hasCueFeatures(e.metrics));

  // the rollouts of the skill's evaluations: compared, never selected
  const evalSets = await getDb()
    .select({ id: datasets.id, report: datasets.report })
    .from(datasets)
    .innerJoin(blocks, eq(blocks.id, datasets.blockId))
    .where(and(eq(datasets.tenantId, tenantId), eq(datasets.skillId, skillId), eq(blocks.kind, "evaluation")));
  const evalEpisodes = evalSets.length
    ? await getDb()
        .select()
        .from(episodes)
        .where(and(eq(episodes.tenantId, tenantId), inArray(episodes.datasetId, evalSets.map((d) => d.id))))
        .orderBy(asc(episodes.index))
    : [];
  const evalReport = new Map(evalSets.map((d) => [d.id, d.report]));
  const evaluation: AnalysisEpisode[] = evalEpisodes
    .map((e) => ({ id: e.id, dataset: e.datasetId, order: e.index, prompt: effectivePrompt(e) || null, metrics: diversityMetricsOf(evalReport.get(e.datasetId), e.index) }))
    .filter((e) => hasCueFeatures(e.metrics));

  const analysis = withFeatures.length ? await criticsClient.analyseShortcuts({ episodes: withFeatures, evaluation }) : null;
  return {
    skillId,
    datasetId: datasetId ?? null,
    datasets: sets.length,
    episodes: withFeatures.length,
    withoutFeatures: selected.length - withFeatures.length,
    evaluationEpisodes: evaluation.length,
    analysis,
  };
}
