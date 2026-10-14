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

/**
 * What keeps an episode from being accepted, one reason each:
 *
 *   gate        a check or a success criterion stops it, whatever the total
 *               score (`source` hard or soft, its score and stop line; a
 *               check can also stop on a flag, then `flag` names it)
 *   rejectFlag  a flag the scoring rejects on
 *   reviewFlag  a flag that caps the episode at review
 *   score       the total score lies below "accept from" (`limit`)
 *   error       a critic failed on the episode, which always means review
 */
export type Blocker =
  | {
      kind: 'gate'
      source: 'hard' | 'soft'
      id: string
      score: number | null
      limit: number | null
      flag?: string
      evidence?: string
    }
  | { kind: 'rejectFlag' | 'reviewFlag'; flag: string }
  | { kind: 'score'; total: number | null; limit: number }
  | { kind: 'error' }

export interface PreviewRow {
  episode: number
  hard: number | null
  soft: number | null
  total: number | null
  verdict: Verdict
  /** what the critics decided in the run */
  ranVerdict: Verdict
  /** the ids of the checks (`duration`) and criteria (`vlm.object_in_target`) that stop the episode */
  gates: string[]
  flags: string[]
  /** why it is not accepted; empty for an accepted episode */
  blockers: Blocker[]
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
  // the form's lists once the person set them, else those the run was scored with
  const reviewFlags = new Set(form.scoring.reviewFlags ?? extra.reviewFlags ?? [])
  const rejectFlags = new Set(form.scoring.rejectFlags ?? extra.rejectFlags ?? [])
  const indicators = new Map(form.soft.indicators.map((i) => [i.id, i]))

  return report.episodes.map((e: SampleEpisode) => {
    const gates: Blocker[] = []
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
      const gateFlag = (c ? c.gateFlags : []).find((f) => own.includes(f))
      if (gateBelow != null && h.score != null && h.score < gateBelow) {
        gates.push({ kind: 'gate', source: 'hard', id: h.id, score: h.score, limit: gateBelow })
      } else if (gateFlag) {
        gates.push({ kind: 'gate', source: 'hard', id: h.id, score: h.score, limit: null, flag: gateFlag })
      } else if (!c && h.gate_failed) {
        gates.push({ kind: 'gate', source: 'hard', id: h.id, score: h.score, limit: h.gate_below })
      }
    }
    const softRows: { score: number | null; weight: number }[] = []
    if (form.soft.enabled) {
      for (const s of e.soft as SampleCriticResult[]) {
        // the model's overall word (task failed, a person in the workspace) counts by its flags only
        if (s.id === 'vlm.summary') {
          s.flags.filter((f) => !muted.has(f)).forEach((f) => flags.add(f))
          continue
        }
        if (!s.id.startsWith('vlm.')) continue
        const ind = indicators.get(s.id.slice(4))
        if (!ind) continue
        softRows.push({ score: s.score, weight: ind.weight })
        s.flags.filter((f) => !muted.has(f)).forEach((f) => flags.add(f))
        if (ind.gate && s.score != null && s.score < ind.gateBelow) {
          gates.push({
            kind: 'gate',
            source: 'soft',
            id: ind.id,
            score: s.score,
            limit: ind.gateBelow,
            evidence: s.evidence[0] || undefined,
          })
        }
      }
    }
    const hard = weightedMean(hardRows)
    const soft = weightedMean(softRows)
    const parts: { score: number; weight: number }[] = []
    if (hard != null) parts.push({ score: hard, weight: form.scoring.hardWeight })
    if (soft != null) parts.push({ score: soft, weight: form.scoring.softWeight })
    const total = weightedMean(parts)
    const flagList = [...flags].sort()
    const rejecting = flagList.filter((f) => rejectFlags.has(f))
    const capping = flagList.filter((f) => reviewFlags.has(f))

    const blockers: Blocker[] = [...gates, ...rejecting.map((flag) => ({ kind: 'rejectFlag' as const, flag }))]
    if (total == null || total < form.scoring.acceptThreshold)
      blockers.push({ kind: 'score', total, limit: form.scoring.acceptThreshold })
    let verdict: Verdict
    if (gates.length || rejecting.length) verdict = 'reject'
    else if (total == null) verdict = 'review'
    else if (total >= form.scoring.acceptThreshold) verdict = 'accept'
    else if (total >= form.scoring.reviewThreshold) verdict = 'review'
    else verdict = 'reject'
    if (verdict === 'accept' && capping.length) {
      verdict = 'review'
      blockers.push(...capping.map((flag) => ({ kind: 'reviewFlag' as const, flag })))
    }
    if (e.error) {
      verdict = 'review'
      blockers.push({ kind: 'error' })
    }
    return {
      episode: e.episode,
      hard,
      soft,
      total,
      verdict,
      ranVerdict: e.score.verdict,
      gates: gates.map((g) => (g.kind === 'gate' && g.source === 'soft' ? `vlm.${g.id}` : (g as { id: string }).id)),
      flags: flagList,
      blockers: verdict === 'accept' ? [] : blockers,
    }
  })
}

/** One reason that holds back episodes of the sample, with the episodes it holds back. */
export interface BlockerGroup {
  key: string
  blocker: Blocker
  episodes: number[]
  /** for a gate: the lowest and highest score among those episodes */
  scores: number[]
}

export const blockerKey = (b: Blocker): string =>
  b.kind === 'gate'
    ? `gate:${b.source}:${b.id}:${b.flag ?? ''}`
    : b.kind === 'score' || b.kind === 'error'
      ? b.kind
      : `${b.kind}:${b.flag}`

/**
 * The reasons over the whole sample, the most frequent first: what to change
 * to get episodes through. A stop counts before the score, because no
 * threshold moves an episode that is stopped.
 */
export function blockerSummary(rows: PreviewRow[]): BlockerGroup[] {
  const groups = new Map<string, BlockerGroup>()
  for (const r of rows) {
    for (const b of r.blockers) {
      const key = blockerKey(b)
      const g = groups.get(key) ?? { key, blocker: b, episodes: [], scores: [] }
      g.episodes.push(r.episode)
      if (b.kind === 'gate' && b.score != null) g.scores.push(b.score)
      if (b.kind === 'score' && b.total != null) g.scores.push(b.total)
      groups.set(key, g)
    }
  }
  const rank = (b: Blocker) => (b.kind === 'gate' || b.kind === 'rejectFlag' ? 0 : b.kind === 'score' ? 2 : 1)
  return [...groups.values()].sort((a, b) => rank(a.blocker) - rank(b.blocker) || b.episodes.length - a.episodes.length)
}

/** What the vision-language model said for one success criterion over the sample. */
export interface IndicatorEvidence {
  id: string
  /** the wording the model judged; differs from the form when the criterion was reworded since */
  judgedText: string
  episodes: { episode: number; score: number | null; evidence: string }[]
  meanScore: number | null
}

export function indicatorEvidence(report: SampleReport): Record<string, IndicatorEvidence> {
  const ran =
    (report.spec?.soft_critics as { indicators?: { id?: string; description?: string }[] } | undefined)?.indicators ?? []
  const text = new Map(ran.map((i) => [String(i.id ?? ''), String(i.description ?? '')]))
  const out: Record<string, IndicatorEvidence> = {}
  for (const e of report.episodes) {
    for (const s of e.soft) {
      if (!s.id.startsWith('vlm.') || s.id === 'vlm.summary') continue
      const id = s.id.slice(4)
      const row = (out[id] ??= { id, judgedText: text.get(id) ?? '', episodes: [], meanScore: null })
      row.episodes.push({ episode: e.episode, score: s.score, evidence: s.evidence[0] ?? '' })
    }
  }
  for (const row of Object.values(out)) {
    const scores = row.episodes.map((x) => x.score).filter((x): x is number => typeof x === 'number')
    row.meanScore = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null
  }
  return out
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

// ---------------------------------------------------------------------------
// the flags of the sample, one by one
// ---------------------------------------------------------------------------

/**
 * What a flag does to an episode with the spec as it stands:
 *
 *   stop     a technical check stops the episode on it (the check's gate flags)
 *   reject   it rejects the episode on its own (scoring.reject_flags)
 *   review   it caps the episode at review (scoring.review_flags)
 *   info     it is shown, nothing more
 *   ignore   it is switched off: not shown, not counted (scoring.ignore_flags)
 */
export type FlagEffect = 'stop' | 'reject' | 'review' | 'info' | 'ignore'

/** One flag raised in the sample, where it came from, what it means and what it does. */
export interface SampleFlag {
  flag: string
  /** `vlm` for the vision-language model, else the technical check that raised it */
  source: 'vlm' | 'check'
  /** the check (`duplication`) or the success criterion (`object_in_target`) behind it, when there is one */
  criticId: string | null
  /** the critics' sentence for it */
  meaning: string
  episodes: number[]
  /** what the model said where it raised the flag: a criterion's reasoning, the anomalies it saw */
  evidence: { episode: number; text: string }[]
  effect: FlagEffect
}

const anomalyText = (metrics: Record<string, unknown>): string => {
  const list = Array.isArray(metrics.anomalies) ? (metrics.anomalies as { description?: unknown; type?: unknown }[]) : []
  return list
    .map((a) => String(a?.description ?? a?.type ?? ''))
    .filter(Boolean)
    .join(' · ')
}

/** What a flag does with the form as it is, given the lists the run was scored with. */
export function flagEffect(
  flag: string,
  form: SpecForm,
  run: { reviewFlags: string[]; rejectFlags: string[] },
  criticId: string | null = null,
): FlagEffect {
  if (form.scoring.ignoreFlags.includes(flag)) return 'ignore'
  if ((form.scoring.rejectFlags ?? run.rejectFlags).includes(flag)) return 'reject'
  const stopping = form.hardCritics.some((c) => c.enabled && c.gateFlags.includes(flag) && (!criticId || c.id === criticId))
  if (stopping) return 'stop'
  if ((form.scoring.reviewFlags ?? run.reviewFlags).includes(flag)) return 'review'
  return 'info'
}

/**
 * Every flag the sample raised, the model's first, then the most frequent.
 * Read from the results as the critics raised them, so a flag the form
 * switches off stays in the list and can be switched on again.
 */
export function sampleFlags(report: SampleReport, form: SpecForm): SampleFlag[] {
  const run = runFlags(report)
  const docs = report.flag_docs ?? {}
  const byFlag = new Map<string, SampleFlag>()
  const add = (flag: string, source: 'vlm' | 'check', criticId: string | null, episode: number, text = '') => {
    const row =
      byFlag.get(flag) ??
      ({ flag, source, criticId, meaning: docs[flag] ?? '', episodes: [], evidence: [], effect: 'info' } as SampleFlag)
    if (!row.episodes.includes(episode)) row.episodes.push(episode)
    if (text) row.evidence.push({ episode, text })
    byFlag.set(flag, row)
  }
  for (const e of report.episodes) {
    for (const h of e.hard) for (const f of h.flags) add(f, 'check', h.id, e.episode)
    for (const s of e.soft) {
      const text = s.id === 'vlm.summary' ? anomalyText(s.metrics ?? {}) : (s.evidence[0] ?? '')
      for (const f of s.flags) add(f, 'vlm', s.id === 'vlm.summary' ? null : s.id.replace(/^vlm\./, ''), e.episode, text)
    }
  }
  const rows = [...byFlag.values()]
  for (const r of rows) r.effect = flagEffect(r.flag, form, run, r.source === 'check' ? r.criticId : null)
  return rows.sort((a, b) => (a.source === b.source ? b.episodes.length - a.episodes.length : a.source === 'vlm' ? -1 : 1))
}

/**
 * Give a flag the effect the person picked. Each flag sits in at most one of
 * the lists; the review list is written out in full the first time it is
 * touched (until then the critics' default applies), so switching one flag
 * never drops the others the default holds.
 */
export function setFlagEffect(
  form: SpecForm,
  flag: string,
  effect: FlagEffect,
  run: { reviewFlags: string[]; rejectFlags: string[] },
  criticId: string | null = null,
): void {
  const without = (list: string[]) => list.filter((f) => f !== flag)
  form.scoring.ignoreFlags = without(form.scoring.ignoreFlags)
  const review = without(form.scoring.reviewFlags ?? run.reviewFlags)
  const reject = without(form.scoring.rejectFlags ?? run.rejectFlags)
  for (const c of form.hardCritics)
    if (c.gateFlags.includes(flag) && (!criticId || c.id === criticId)) c.gateFlags = without(c.gateFlags)
  if (effect === 'ignore') form.scoring.ignoreFlags = [...form.scoring.ignoreFlags, flag]
  if (effect === 'review') review.push(flag)
  if (effect === 'reject') reject.push(flag)
  if (effect === 'stop' && criticId) {
    const c = form.hardCritics.find((x) => x.id === criticId)
    if (c) {
      c.gateFlags = [...c.gateFlags, flag]
      c.enabled = true
    }
  }
  // only write a list out when it differs from what the run used, so an untouched spec stays short
  const same = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x))
  form.scoring.reviewFlags = form.scoring.reviewFlags || !same(review, run.reviewFlags) ? review : null
  form.scoring.rejectFlags = form.scoring.rejectFlags || !same(reject, run.rejectFlags) ? reject : null
}
