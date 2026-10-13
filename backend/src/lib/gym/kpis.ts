/**
 * Key figures for the analyst: how much was recorded, how good it was and
 * how fast it went, over a period, per cell and per day, and how the
 * evaluations went.
 *
 *   episodes / accepted / review / rejected   the effective verdicts on the recording datasets (a person's word over the critics')
 *   selected                  the operator's export decision
 *   teleop minutes            the sum of the windows of the recording blocks (lib/gym/teleop.ts)
 *   evaluation minutes        the sum of the windows of the evaluation blocks
 *   recorded seconds          the sum of the episode durations of the recording datasets
 *   downtime minutes          what the operators wrote down by hand, per day
 *   episodes per hour         episodes / teleop hours
 *   accept rate               accepted / episodes (null while nothing was analysed)
 *   evaluation                blocks, judged rollouts, accepted rollouts and the success rate
 *
 * It also collects the runs whose vision-language model failed. Such a run is
 * "done" for the critics service (the hard critics carried it) but only half
 * judged, and that has to be visible on the analysis page instead of looking
 * like a clean run with no soft findings.
 */
import { and, eq, gte, inArray, lte } from "drizzle-orm";
import { getDb } from "@framework/lib/db/db-connection";
import { blocks, cells, datasets, dayProtocols, episodes, skills, type BlockKind } from "../../db/schema";
import { downtimeMinutes, teleopMinutes } from "./teleop";

export interface KpiFilter {
  from?: string;
  to?: string;
  cellId?: string;
  collectionId?: string;
  skillId?: string;
}

export interface EvaluationTotals {
  blocks: number;
  episodes: number;
  accepted: number;
  /** accepted / episodes of the evaluation rollouts; null while nothing was judged */
  successRatePercent: number | null;
  minutes: number;
}

export interface KpiTotals {
  skills: number;
  days: number;
  blocks: number;
  datasets: number;
  episodes: number;
  accepted: number;
  review: number;
  rejected: number;
  selected: number;
  acceptRatePercent: number | null;
  teleopMinutes: number;
  episodesPerHour: number | null;
  recordedSeconds: number | null;
  downtimeMinutes: number;
  evaluation: EvaluationTotals;
}

/** One run whose vision-language model did not answer, with where to find it. */
export interface VlmFailure {
  datasetId: string;
  datasetName: string;
  skillId: string;
  skillName: string;
  dayProtocolId: string;
  blockId: string;
  kind: BlockKind;
  date: string;
  cellName: string;
  episodes: number;
  /** episodes the model failed on */
  failedEpisodes: number;
  error: string | null;
}

export interface KpiPerDay {
  date: string;
  episodes: number;
  accepted: number;
  teleopMinutes: number;
  evaluationMinutes: number;
  /** day protocols with a block in the filter */
  days: number;
  blocks: number;
}

export interface KpiResult {
  totals: KpiTotals;
  perCell: (KpiTotals & { cellId: string; cellName: string })[];
  perDay: KpiPerDay[];
  /** flag → episodes it was raised on, across every analysed recording dataset */
  flags: { flag: string; count: number }[];
  /** runs the vision-language model failed on: judged by the hard critics alone */
  vlmFailures: VlmFailure[];
}

const round1 = (v: number) => Math.round(v * 10) / 10;

const emptyTotals = (): KpiTotals => ({
  skills: 0,
  days: 0,
  blocks: 0,
  datasets: 0,
  episodes: 0,
  accepted: 0,
  review: 0,
  rejected: 0,
  selected: 0,
  acceptRatePercent: null,
  teleopMinutes: 0,
  episodesPerHour: null,
  recordedSeconds: null,
  downtimeMinutes: 0,
  evaluation: { blocks: 0, episodes: 0, accepted: 0, successRatePercent: null, minutes: 0 },
});

const finish = (t: KpiTotals): KpiTotals => ({
  ...t,
  acceptRatePercent: t.episodes ? round1((t.accepted / t.episodes) * 100) : null,
  episodesPerHour: t.teleopMinutes > 0 ? round1(t.episodes / (t.teleopMinutes / 60)) : null,
  teleopMinutes: Math.round(t.teleopMinutes),
  downtimeMinutes: Math.round(t.downtimeMinutes),
  recordedSeconds: t.recordedSeconds == null ? null : Math.round(t.recordedSeconds),
  evaluation: {
    ...t.evaluation,
    successRatePercent: t.evaluation.episodes ? round1((t.evaluation.accepted / t.evaluation.episodes) * 100) : null,
    minutes: Math.round(t.evaluation.minutes),
  },
});

export async function getKpis(tenantId: string, filter: KpiFilter = {}): Promise<KpiResult> {
  const conditions = [eq(blocks.tenantId, tenantId)];
  if (filter.from) conditions.push(gte(dayProtocols.date, filter.from));
  if (filter.to) conditions.push(lte(dayProtocols.date, filter.to));
  if (filter.cellId) conditions.push(eq(dayProtocols.cellId, filter.cellId));
  if (filter.collectionId) conditions.push(eq(skills.collectionId, filter.collectionId));
  if (filter.skillId) conditions.push(eq(blocks.skillId, filter.skillId));
  const rows = await getDb()
    .select({ block: blocks, day: dayProtocols, cellName: cells.name, skillName: skills.name })
    .from(blocks)
    .innerJoin(dayProtocols, eq(dayProtocols.id, blocks.dayProtocolId))
    .innerJoin(cells, eq(cells.id, dayProtocols.cellId))
    .innerJoin(skills, eq(skills.id, blocks.skillId))
    .where(and(...conditions));
  const result: KpiResult = { totals: emptyTotals(), perCell: [], perDay: [], flags: [], vlmFailures: [] };
  if (!rows.length) return result;

  const blockIds = rows.map((r) => r.block.id);
  const dsRows = await getDb().select().from(datasets).where(inArray(datasets.blockId, blockIds));
  const epRows = dsRows.length
    ? await getDb()
        .select({
          datasetId: episodes.datasetId,
          verdict: episodes.verdict,
          humanVerdict: episodes.humanVerdict,
          selected: episodes.selected,
          durationSeconds: episodes.durationSeconds,
        })
        .from(episodes)
        .where(inArray(episodes.datasetId, dsRows.map((d) => d.id)))
    : [];
  const dsByBlock = new Map<string, typeof dsRows>();
  for (const d of dsRows) dsByBlock.set(d.blockId, [...(dsByBlock.get(d.blockId) ?? []), d]);
  const epByDs = new Map<string, typeof epRows>();
  for (const e of epRows) epByDs.set(e.datasetId, [...(epByDs.get(e.datasetId) ?? []), e]);

  type Acc = KpiTotals & { skillIds: Set<string>; dayIds: Set<string> };
  const acc = (): Acc => ({ ...emptyTotals(), skillIds: new Set(), dayIds: new Set() });
  const total = acc();
  const perCell = new Map<string, Acc & { cellId: string; cellName: string }>();
  const perDay = new Map<string, KpiPerDay & { dayIds: Set<string> }>();
  const flags = new Map<string, number>();
  const now = Date.now();

  /** add one block to an accumulator; the downtime of its day is added once per day */
  const add = (t: Acc, r: (typeof rows)[number]) => {
    t.blocks += 1;
    t.skillIds.add(r.block.skillId);
    if (!t.dayIds.has(r.day.id)) {
      t.dayIds.add(r.day.id);
      t.downtimeMinutes += downtimeMinutes(r.day);
    }
    const minutes = teleopMinutes(r.block, now);
    const evaluation = r.block.kind === "evaluation";
    if (evaluation) {
      t.evaluation.blocks += 1;
      t.evaluation.minutes += minutes;
    } else {
      t.teleopMinutes += minutes;
    }
    for (const ds of dsByBlock.get(r.block.id) ?? []) {
      if (!evaluation) t.datasets += 1;
      for (const e of epByDs.get(ds.id) ?? []) {
        if (evaluation) {
          // a rollout's success is the human's word where there is one, else the critics'
          t.evaluation.episodes += 1;
          if ((e.humanVerdict ?? e.verdict) === "accept") t.evaluation.accepted += 1;
          continue;
        }
        t.episodes += 1;
        const verdict = e.humanVerdict ?? e.verdict;
        if (verdict === "accept") t.accepted += 1;
        if (verdict === "review") t.review += 1;
        if (verdict === "reject") t.rejected += 1;
        if (e.selected) t.selected += 1;
        if (e.durationSeconds != null) t.recordedSeconds = (t.recordedSeconds ?? 0) + e.durationSeconds;
      }
    }
    return minutes;
  };
  const done = ({ skillIds, dayIds, ...t }: Acc): KpiTotals => finish({ ...t, skills: skillIds.size, days: dayIds.size });

  for (const r of rows) {
    const minutes = add(total, r);
    const cell = perCell.get(r.day.cellId) ?? { ...acc(), cellId: r.day.cellId, cellName: r.cellName };
    add(cell, r);
    perCell.set(r.day.cellId, cell);
    const pd = perDay.get(r.day.date) ?? { date: r.day.date, episodes: 0, accepted: 0, teleopMinutes: 0, evaluationMinutes: 0, days: 0, blocks: 0, dayIds: new Set<string>() };
    pd.blocks += 1;
    pd.dayIds.add(r.day.id);
    if (r.block.kind === "evaluation") pd.evaluationMinutes += minutes;
    else pd.teleopMinutes += minutes;
    for (const ds of dsByBlock.get(r.block.id) ?? []) {
      if (r.block.kind === "recording") for (const f of ds.analysis?.flagCounts ?? []) flags.set(f.flag, (flags.get(f.flag) ?? 0) + f.count);
      if (ds.analysis?.softCriticsFailed) {
        result.vlmFailures.push({
          datasetId: ds.id,
          datasetName: ds.name,
          skillId: r.block.skillId,
          skillName: r.skillName,
          dayProtocolId: r.day.id,
          blockId: r.block.id,
          kind: r.block.kind,
          date: r.day.date,
          cellName: r.cellName,
          episodes: ds.analysis.episodes,
          failedEpisodes: ds.analysis.softCriticsFailedEpisodes,
          error: ds.analysis.softCriticsError,
        });
      }
      if (r.block.kind === "recording") {
        for (const e of epByDs.get(ds.id) ?? []) {
          pd.episodes += 1;
          if ((e.humanVerdict ?? e.verdict) === "accept") pd.accepted += 1;
        }
      }
    }
    perDay.set(r.day.date, pd);
  }
  result.totals = done(total);
  result.perCell = [...perCell.values()]
    .map(({ cellId, cellName, ...t }) => ({ ...done(t), cellId, cellName }))
    .sort((a, b) => a.cellName.localeCompare(b.cellName));
  result.perDay = [...perDay.values()]
    .map(({ dayIds, ...d }) => ({ ...d, days: dayIds.size, teleopMinutes: Math.round(d.teleopMinutes), evaluationMinutes: Math.round(d.evaluationMinutes) }))
    .sort((a, b) => a.date.localeCompare(b.date));
  result.flags = [...flags.entries()].map(([flag, count]) => ({ flag, count })).sort((a, b) => b.count - a.count);
  result.vlmFailures.sort((a, b) => b.date.localeCompare(a.date) || a.datasetName.localeCompare(b.datasetName));
  return result;
}
