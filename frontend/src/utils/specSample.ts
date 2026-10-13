/**
 * What the sample of the spec wizard says about each part of the spec.
 *
 * The critics ran over X episodes of the sample (backend/src/lib/gym/spec-drafts.ts)
 * and their report is read here, field by field, so every step of the wizard
 * can show its evidence next to its inputs: the tasks the dataset carries, the
 * repetitions per episode, how each technical check scored and what it
 * flagged, how long the episodes are.
 *
 * `previewVerdicts` replays the critics' weighted aggregation
 * (lerobot_critics.scoring.aggregate) over the critic results of the sample
 * with the weights, gates, thresholds and muted flags of the form. It is a
 * preview, not a verdict: the results themselves are the critics', and what a
 * changed parameter or a new success indicator would measure only the test
 * run shows. The wizard says so where it shows the preview.
 */
import type { SampleCriticResult, SampleEpisode, SampleReport } from '@/types/gym'
import type { SpecForm } from '@/utils/spec'

export type Verdict = 'accept' | 'review' | 'reject'

const median = (values: number[]): number | null => {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}

/** The distinct task texts of the sampled episodes, most frequent first. */
export function sampleTasks(report: SampleReport): { task: string; episodes: number }[] {
  const counts = new Map<string, number>()
  for (const e of report.episodes) if (e.task) counts.set(e.task, (counts.get(e.task) ?? 0) + 1)
  return [...counts.entries()].map(([task, episodes]) => ({ task, episodes })).sort((a, b) => b.episodes - a.episodes)
}

/** A numeric metric of one critic over the sample: smallest, median, largest. */
export function metricRange(
  report: SampleReport,
  criticId: string,
  key: string,
): { min: number; median: number; max: number; n: number } | null {
  const values: number[] = []
  for (const e of report.episodes) {
    const v = e.hard.find((h) => h.id === criticId)?.metrics?.[key]
    if (typeof v === 'number' && Number.isFinite(v)) values.push(v)
  }
  if (!values.length) return null
  return { min: Math.min(...values), median: median(values)!, max: Math.max(...values), n: values.length }
}

/** How long the episodes of the sample are, in seconds. */
export function durationRange(report: SampleReport) {
  const values = report.episodes.map((e) => e.duration_s).filter((v) => Number.isFinite(v) && v > 0)
  if (!values.length) return null
  return { min: Math.min(...values), median: median(values)!, max: Math.max(...values) }
}

/** Grasp cycles the critics counted per episode, and the most common count. */
export function cycleCounts(report: SampleReport): { perEpisode: { episode: number; cycles: number }[]; typical: number | null } {
  const perEpisode = report.episodes.flatMap((e) => {
    const n = e.hard.find((h) => h.id === 'grasp_cycles')?.metrics?.n_cycles
    return typeof n === 'number' ? [{ episode: e.episode, cycles: n }] : []
  })
  const m = median(perEpisode.map((p) => p.cycles))
  return { perEpisode, typical: m == null ? null : Math.round(m) }
}

/** One technical check over the sample: how it scored and what it found. */
export interface CriticEvidence {
  id: string
  /** episodes the check produced a score for */
  scored: number
  meanScore: number | null
  minScore: number | null
  /** episodes with at least one flag of this check */
  flagged: number
  /** episodes the check stopped on its own (gate) */
  gateFailed: number
  flags: Record<string, number>
  errors: number
}

export function criticEvidence(report: SampleReport): Record<string, CriticEvidence> {
  const out: Record<string, CriticEvidence> = {}
  for (const e of report.episodes) {
    for (const h of e.hard) {
      const row = (out[h.id] ??= {
        id: h.id,
        scored: 0,
        meanScore: null,
        minScore: null,
        flagged: 0,
        gateFailed: 0,
        flags: {},
        errors: 0,
      })
      if (h.error) row.errors++
      if (typeof h.score === 'number') {
        row.meanScore = ((row.meanScore ?? 0) * row.scored + h.score) / (row.scored + 1)
        row.minScore = row.minScore == null ? h.score : Math.min(row.minScore, h.score)
        row.scored++
      }
      if (h.flags.length) row.flagged++
      if (h.gate_failed) row.gateFailed++
      for (const f of h.flags) row.flags[f] = (row.flags[f] ?? 0) + 1
    }
  }
  return out
}

/** Did the vision-language model judge the sample, or was it off or unreachable? */
export function softState(report: SampleReport): 'judged' | 'failed' | 'off' {
  const soft = report.episodes.flatMap((e) => e.soft)
  if (!soft.length) return 'off'
  return soft.some((s) => typeof s.score === 'number') ? 'judged' : 'failed'
}

/** The first error the vision-language model reported, to say why it did not judge. */
export const softError = (report: SampleReport): string | null =>
  report.episodes
    .flatMap((e) => e.soft)
    .find((s) => s.error)
    ?.error?.split('\n')[0] ?? null

export interface PreviewRow {
  episode: number
  hard: number | null
  soft: number | null
  total: number | null
  verdict: Verdict
  /** what the critics decided in the run */
  ranVerdict: Verdict
  gates: string[]
  flags: string[]
}

const weightedMean = (rows: { score: number | null; weight: number }[]): number | null => {
  let num = 0
  let den = 0
  for (const r of rows) {
    if (r.score == null || r.weight <= 0) continue
    num += r.weight * r.score
    den += r.weight
  }
  return den > 0 ? num / den : null
}

/**
 * The verdicts the sample would get with the form as it is, from the critic
 * results of the run. `reviewFlags` and `rejectFlags` are those the run was
 * scored with (the form has no field for them).
 */
export function previewVerdicts(
  report: SampleReport,
  form: SpecForm,
  extra: { reviewFlags?: string[]; rejectFlags?: string[] } = {},
): PreviewRow[] {
  const muted = new Set(form.scoring.ignoreFlags)
  const reviewFlags = new Set(extra.reviewFlags ?? [])
  const rejectFlags = new Set(extra.rejectFlags ?? [])
  const indicators = new Map(form.soft.indicators.map((i) => [i.id, i]))

  return report.episodes.map((e: SampleEpisode) => {
    const gates: string[] = []
    const flags = new Set<string>()
    const hardRows: { score: number | null; weight: number }[] = []
    for (const h of e.hard) {
      const c = form.hardCritics.find((x) => x.id === h.id)
      if (c && !c.enabled) continue
      const own = h.flags.filter((f) => !muted.has(f))
      own.forEach((f) => flags.add(f))
      const weight = c ? c.weight : h.weight
      hardRows.push({ score: h.score, weight })
      const gateBelow = c ? (c.gate ? c.gateBelow : null) : h.gate ? h.gate_below : null
      const gateFlags = c ? c.gateFlags : []
      const failed =
        (gateBelow != null && h.score != null && h.score < gateBelow) ||
        gateFlags.some((f) => own.includes(f)) ||
        (!c && h.gate_failed)
      if (failed) gates.push(h.id)
    }
    const softRows: { score: number | null; weight: number }[] = []
    if (form.soft.enabled) {
      for (const s of e.soft as SampleCriticResult[]) {
        if (!s.id.startsWith('vlm.') || s.id === 'vlm.summary') continue
        const ind = indicators.get(s.id.slice(4))
        if (!ind) continue
        softRows.push({ score: s.score, weight: ind.weight })
        s.flags.filter((f) => !muted.has(f)).forEach((f) => flags.add(f))
        if (ind.gate && s.score != null && s.score < ind.gateBelow) gates.push(s.id)
      }
    }
    const hard = weightedMean(hardRows)
    const soft = weightedMean(softRows)
    const parts: { score: number; weight: number }[] = []
    if (hard != null) parts.push({ score: hard, weight: form.scoring.hardWeight })
    if (soft != null) parts.push({ score: soft, weight: form.scoring.softWeight })
    const total = weightedMean(parts)
    const flagList = [...flags].sort()
    let verdict: Verdict
    if (gates.length || flagList.some((f) => rejectFlags.has(f))) verdict = 'reject'
    else if (total == null) verdict = 'review'
    else if (total >= form.scoring.acceptThreshold) verdict = 'accept'
    else if (total >= form.scoring.reviewThreshold) verdict = 'review'
    else verdict = 'reject'
    if (verdict === 'accept' && flagList.some((f) => reviewFlags.has(f))) verdict = 'review'
    if (e.error) verdict = 'review'
    return { episode: e.episode, hard, soft, total, verdict, ranVerdict: e.score.verdict, gates, flags: flagList }
  })
}

export const countVerdicts = (rows: { verdict: Verdict }[]): Record<Verdict, number> => {
  const out: Record<Verdict, number> = { accept: 0, review: 0, reject: 0 }
  for (const r of rows) out[r.verdict]++
  return out
}

/** The flags the run was scored with that the form has no field for: review and reject caps. */
export function runFlags(report: SampleReport): { reviewFlags: string[]; rejectFlags: string[] } {
  const scoring = (report.spec?.scoring ?? {}) as { review_flags?: unknown; reject_flags?: unknown }
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
  return { reviewFlags: list(scoring.review_flags), rejectFlags: list(scoring.reject_flags) }
}
