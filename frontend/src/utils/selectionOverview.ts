import type { AxisStat, Episode, EpisodeTotals, SelectionMetrics, SelectionView } from '@/types/gym'

const effective = (e: Pick<Episode, 'verdict' | 'humanVerdict'>) => e.humanVerdict ?? e.verdict

/**
 * The selection narrowed to one dataset, counted on its own: what a dataset
 * row of the Episodes tab opens to. Counts are on the effective verdict, a
 * person's word over the critics'.
 */
export function narrowSelection(view: SelectionView, datasetId: string): SelectionView {
  const datasets = view.datasets.filter((d) => d.dataset.id === datasetId)
  const episodes = datasets.flatMap((d) => d.episodes)
  const totals: EpisodeTotals = {
    ...view.totals,
    episodes: episodes.length,
    accepted: episodes.filter((e) => effective(e) === 'accept').length,
    review: episodes.filter((e) => effective(e) === 'review').length,
    rejected: episodes.filter((e) => effective(e) === 'reject').length,
    selected: episodes.filter((e) => e.selected).length,
  }
  return { skillId: view.skillId, datasets, totals }
}

/** Three values per axis as "x / y / z" with one decimal; a dash for nothing. */
export const fmtAxis = (v: readonly number[] | null | undefined): string =>
  v?.length ? v.map((n) => n.toFixed(1)).join(' / ') : '–'

/** One line of the position table: what it is about and its figures. */
export interface MetricRow {
  /** pick positions, or the wrists at the start or at the end of the episode */
  group: 'pick' | 'start' | 'end'
  /** over everything, for one arm, or the delta between the sides (left minus right) */
  kind: 'all' | 'arm' | 'delta'
  arm?: string
  stat: AxisStat
}

/**
 * The lines of the position table in reading order: where was picked (overall,
 * then per arm when more than one arm picked), then each wrist at the start
 * with the delta between the sides, then the same at the end. Lines without a
 * figure are left out.
 */
export function metricRows(m: SelectionMetrics): MetricRow[] {
  const rows: MetricRow[] = []
  if (m.pick.all) rows.push({ group: 'pick', kind: 'all', stat: m.pick.all })
  const arms = Object.entries(m.pick.byArm)
  if (arms.length > 1) for (const [arm, stat] of arms) rows.push({ group: 'pick', kind: 'arm', arm, stat })
  const wrists = (group: 'start' | 'end', byArm: Record<string, AxisStat>, delta: AxisStat | null) => {
    for (const [arm, stat] of Object.entries(byArm)) rows.push({ group, kind: 'arm', arm, stat })
    if (delta) rows.push({ group, kind: 'delta', stat: delta })
  }
  wrists('start', m.wristStart, m.deltaStart)
  wrists('end', m.wristEnd, m.deltaEnd)
  return rows
}
