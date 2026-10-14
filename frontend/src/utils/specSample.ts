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
  /** what went into the total: every check and criterion that counts, with its score and weight */
  hardParts: ScorePart[]
  softParts: ScorePart[]
  /** the verdict of the total score against the thresholds alone, before stops and flags */
  scoreVerdict: Verdict | null
  /** flags on the episode that cap it at review, and that reject it */
  caps: string[]
  rejects: string[]
  /** results of the episode that do not go into the total, and why */
  skipped: SkippedPart[]
  /** the weights the two sides go into the total with; a side without a score has none */
  sideWeights: { hard: number; soft: number }
  /** the rule that decided the verdict, in the order the critics apply them */
  decidedBy: Decision
}

/**
 * The rules of `lerobot_critics.scoring.aggregate` in their order; the first
 * that holds decides: a stop or a rejecting flag rejects, no score at all is
 * review, then the total against the thresholds, and an accept with a
 * capping flag becomes review. A failed run of the episode is review.
 */
export type Decision = 'stop' | 'rejectFlag' | 'noScore' | 'accept' | 'review' | 'belowReview' | 'cap' | 'error'

/** A result that is left out of the total: switched off, weight 0, no score, or one that counts by its flags only. */
export interface SkippedPart {
  source: 'hard' | 'soft'
  id: string
  reason: 'off' | 'weight0' | 'noScore' | 'flagsOnly' | 'notInSpec'
}

/** One result in the total score: its score, its weight, and what it costs the total (from 1). */
export interface ScorePart {
  id: string
  score: number
  weight: number
  /** how much lower the total is because this result is not 1: weight share times (1 minus score) */
  cost: number
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
    const hardRows: { id: string; score: number | null; weight: number }[] = []
    const skipped: SkippedPart[] = []
    for (const h of e.hard) {
      const c = form.hardCritics.find((x) => x.id === h.id)
      if (c && !c.enabled) {
        skipped.push({ source: 'hard', id: h.id, reason: 'off' })
        continue
      }
      const own = h.flags.filter((f) => !muted.has(f))
      own.forEach((f) => flags.add(f))
      const weight = c ? c.weight : h.weight
      hardRows.push({ id: h.id, score: h.score, weight })
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
    const softRows: { id: string; score: number | null; weight: number }[] = []
    if (form.soft.enabled) {
      for (const s of e.soft as SampleCriticResult[]) {
        // the model's overall word (task failed, a person in the workspace) counts by its flags only
        if (s.id === 'vlm.summary') {
          s.flags.filter((f) => !muted.has(f)).forEach((f) => flags.add(f))
          skipped.push({ source: 'soft', id: 'summary', reason: 'flagsOnly' })
          continue
        }
        if (!s.id.startsWith('vlm.')) continue
        const ind = indicators.get(s.id.slice(4))
        if (!ind) {
          skipped.push({ source: 'soft', id: s.id.slice(4), reason: 'notInSpec' })
          continue
        }
        softRows.push({ id: ind.id, score: s.score, weight: ind.weight })
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
    for (const [source, rows] of [
      ['hard', hardRows],
      ['soft', softRows],
    ] as const) {
      for (const r of rows) {
        if (r.score == null) skipped.push({ source, id: r.id, reason: 'noScore' })
        else if (r.weight <= 0) skipped.push({ source, id: r.id, reason: 'weight0' })
      }
    }
    const hard = weightedMean(hardRows)
    const soft = weightedMean(softRows)
    const parts: { score: number; weight: number }[] = []
    if (hard != null) parts.push({ score: hard, weight: form.scoring.hardWeight })
    if (soft != null) parts.push({ score: soft, weight: form.scoring.softWeight })
    const total = weightedMean(parts)
    // what each result costs the total: its share of its side, times its side's share of the total
    const sideShare = (w: number) => {
      const sum = (hard != null ? form.scoring.hardWeight : 0) + (soft != null ? form.scoring.softWeight : 0)
      return sum > 0 ? w / sum : 0
    }
    const partsOf = (rows: { id: string; score: number | null; weight: number }[], side: number): ScorePart[] => {
      const counted = rows.filter((r): r is { id: string; score: number; weight: number } => r.score != null && r.weight > 0)
      const sum = counted.reduce((a, r) => a + r.weight, 0)
      return counted.map((r) => ({ ...r, cost: sum > 0 ? (side * r.weight * (1 - r.score)) / sum : 0 }))
    }
    const hardParts = partsOf(hardRows, hard != null ? sideShare(form.scoring.hardWeight) : 0)
    const softParts = partsOf(softRows, soft != null ? sideShare(form.scoring.softWeight) : 0)
    const scoreVerdict: Verdict | null =
      total == null
        ? null
        : total >= form.scoring.acceptThreshold
          ? 'accept'
          : total >= form.scoring.reviewThreshold
            ? 'review'
            : 'reject'
    const flagList = [...flags].sort()
    const rejecting = flagList.filter((f) => rejectFlags.has(f))
    const capping = flagList.filter((f) => reviewFlags.has(f))

    const blockers: Blocker[] = [...gates, ...rejecting.map((flag) => ({ kind: 'rejectFlag' as const, flag }))]
    if (total == null || total < form.scoring.acceptThreshold)
      blockers.push({ kind: 'score', total, limit: form.scoring.acceptThreshold })
    let verdict: Verdict
    let decidedBy: Decision
    if (gates.length) [verdict, decidedBy] = ['reject', 'stop']
    else if (rejecting.length) [verdict, decidedBy] = ['reject', 'rejectFlag']
    else if (total == null) [verdict, decidedBy] = ['review', 'noScore']
    else if (total >= form.scoring.acceptThreshold) [verdict, decidedBy] = ['accept', 'accept']
    else if (total >= form.scoring.reviewThreshold) [verdict, decidedBy] = ['review', 'review']
    else [verdict, decidedBy] = ['reject', 'belowReview']
    if (verdict === 'accept' && capping.length) {
      verdict = 'review'
      decidedBy = 'cap'
      blockers.push(...capping.map((flag) => ({ kind: 'reviewFlag' as const, flag })))
    }
    if (e.error) {
      verdict = 'review'
      decidedBy = 'error'
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
      hardParts,
      softParts,
      scoreVerdict,
      caps: capping,
      rejects: rejecting,
      skipped,
      sideWeights: {
        hard: hard != null ? form.scoring.hardWeight : 0,
        soft: soft != null ? form.scoring.softWeight : 0,
      },
      decidedBy,
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

// ---------------------------------------------------------------------------
// the workbench: one episode in full, and the person's word against the spec
// ---------------------------------------------------------------------------

/** What is open on the right of the workbench: a result of the episode, or nothing (the whole spec). */
export type Selection = { kind: 'check' | 'criterion' | 'model'; id: string } | null

/** One result of the critics on one episode, read against the form as it stands. */
export interface ResultRow {
  /** `check` a technical check, `criterion` a success criterion, `model` the model's overall word */
  kind: 'check' | 'criterion' | 'model'
  /** the check id (`duplication`), the criterion id (`object_in_target`), or `summary` */
  id: string
  score: number | null
  /** the weight the form gives it; 0 for the model's overall word, which counts by its flags only */
  weight: number
  /** switched on in the form (a criterion the form no longer has is off) */
  enabled: boolean
  /** the stop line of the form, when the result has one */
  stopBelow: number | null
  /** stopped with the form as it stands (by its score or, for a check, by a flag) */
  stopped: boolean
  flags: { flag: string; effect: FlagEffect }[]
  /** what the model said, or the anomalies it saw */
  evidence: string
  metrics: Record<string, unknown>
  error: string | null
}

/** Every result of one episode, the model's first, each with what the form makes of it. */
export function resultRows(report: SampleReport, form: SpecForm, episode: number): ResultRow[] {
  const e = report.episodes.find((x) => x.episode === episode)
  if (!e) return []
  const run = runFlags(report)
  const flagsOf = (flags: string[], criticId: string | null) =>
    flags.map((flag) => ({ flag, effect: flagEffect(flag, form, run, criticId) }))
  const rows: ResultRow[] = []
  for (const s of e.soft) {
    if (s.id === 'vlm.summary') {
      rows.push({
        kind: 'model',
        id: 'summary',
        score: s.score,
        weight: 0,
        enabled: form.soft.enabled,
        stopBelow: null,
        stopped: false,
        flags: flagsOf(s.flags, null),
        evidence: anomalyText(s.metrics ?? {}),
        metrics: s.metrics ?? {},
        error: s.error,
      })
      continue
    }
    const id = s.id.replace(/^vlm\./, '')
    const ind = form.soft.indicators.find((i) => i.id === id)
    const stopBelow = ind?.gate ? ind.gateBelow : null
    rows.push({
      kind: 'criterion',
      id,
      score: s.score,
      weight: ind?.weight ?? 0,
      enabled: form.soft.enabled && !!ind,
      stopBelow,
      stopped: !!ind && form.soft.enabled && stopBelow != null && s.score != null && s.score < stopBelow,
      flags: flagsOf(s.flags, null),
      evidence: s.evidence[0] ?? '',
      metrics: s.metrics ?? {},
      error: s.error,
    })
  }
  for (const h of e.hard) {
    const c = form.hardCritics.find((x) => x.id === h.id)
    const enabled = c ? c.enabled : true
    const stopBelow = c ? (c.gate ? c.gateBelow : null) : h.gate ? h.gate_below : null
    const flags = flagsOf(h.flags, h.id)
    rows.push({
      kind: 'check',
      id: h.id,
      score: h.score,
      weight: c ? c.weight : h.weight,
      enabled,
      stopBelow,
      stopped:
        enabled && ((stopBelow != null && h.score != null && h.score < stopBelow) || flags.some((f) => f.effect === 'stop')),
      flags,
      evidence: h.evidence.join(' · '),
      metrics: h.metrics ?? {},
      error: h.error,
    })
  }
  return rows
}

/** Does the spec decide differently from the person? Review counts as "not accepted". */
export const disagrees = (verdict: Verdict, judgment: 'accept' | 'reject' | undefined): boolean =>
  judgment === 'accept' ? verdict !== 'accept' : judgment === 'reject' ? verdict === 'accept' : false

/** How the spec as it stands agrees with the person's word on the sample. */
export function agreement(rows: PreviewRow[], judgments: Record<string, 'accept' | 'reject'>) {
  const judged = rows.filter((r) => judgments[String(r.episode)])
  const differ = judged.filter((r) => disagrees(r.verdict, judgments[String(r.episode)])).map((r) => r.episode)
  return { judged: judged.length, agree: judged.length - differ.length, differ }
}

/** The scores of one result over the sample, for the dots on a slider. */
export function scoresOf(report: SampleReport, kind: 'check' | 'criterion', id: string): { episode: number; score: number }[] {
  return report.episodes.flatMap((e) => {
    const r = kind === 'check' ? e.hard.find((h) => h.id === id) : e.soft.find((s) => s.id === `vlm.${id}`)
    return typeof r?.score === 'number' ? [{ episode: e.episode, score: r.score }] : []
  })
}

// ---------------------------------------------------------------------------
// the way to accept: what would have to change for one episode
// ---------------------------------------------------------------------------

/**
 * One change of the spec that moves an episode towards accept. It changes
 * the spec for every episode, so the workbench shows what else it moves.
 *
 *   flag        give a flag the effect "note only" (a cap, a reject, a check's stop on it)
 *   liftStop    a check or a criterion no longer stops
 *   lowerStop   its stop line goes just under the episode's score
 *   acceptAt    "accept from" goes down to the episode's total
 *   weightZero  a result that costs the total a lot no longer counts (`totalAfter`
 *               says where the total would be then; it may still be short)
 */
export type Fix =
  | { type: 'flag'; flag: string; checkId: string | null }
  | { type: 'liftStop' | 'lowerStop'; source: 'hard' | 'soft'; id: string; to?: number }
  | { type: 'acceptAt'; to: number }
  | { type: 'weightZero'; source: 'hard' | 'soft'; id: string; totalAfter: number }

/** a value just below `v` on a 0.01 grid: a line there lets `v` pass */
const justBelow = (v: number) => Math.floor((v - 1e-9) * 100) / 100

/**
 * The changes that would let this episode be accepted, in the order they
 * matter: the stops first (nothing else helps while one fires), then flags
 * that reject or cap, then the score. Each stop gets its own line; for the
 * score both ways are offered, a lower threshold or a result that no longer
 * counts.
 */
export function fixesFor(row: PreviewRow, form: SpecForm): Fix[] {
  if (row.verdict === 'accept') return []
  const fixes: Fix[] = []
  for (const b of row.blockers) {
    if (b.kind !== 'gate') continue
    if (b.flag) fixes.push({ type: 'flag', flag: b.flag, checkId: b.id })
    else if (b.score != null && justBelow(b.score) >= 0.01)
      fixes.push({ type: 'lowerStop', source: b.source, id: b.id, to: justBelow(b.score) })
    else fixes.push({ type: 'liftStop', source: b.source, id: b.id })
  }
  for (const flag of row.rejects) fixes.push({ type: 'flag', flag, checkId: null })
  for (const flag of row.caps) fixes.push({ type: 'flag', flag, checkId: null })
  if (row.total != null && row.total < form.scoring.acceptThreshold) {
    fixes.push({ type: 'acceptAt', to: Math.floor(row.total * 100) / 100 })
    // a result that costs enough that the total would reach the threshold without it
    const parts = [
      ...row.hardParts.map((p) => ({ ...p, source: 'hard' as const })),
      ...row.softParts.map((p) => ({ ...p, source: 'soft' as const })),
    ].sort((a, b) => b.cost - a.cost)
    for (const p of parts.slice(0, 3)) {
      const side = p.source === 'hard' ? row.hardParts : row.softParts
      const rest = side.filter((x) => x.id !== p.id)
      const restMean = rest.length
        ? rest.reduce((a, x) => a + x.weight * x.score, 0) / rest.reduce((a, x) => a + x.weight, 0)
        : null
      const other = p.source === 'hard' ? row.soft : row.hard
      const wSelf = p.source === 'hard' ? form.scoring.hardWeight : form.scoring.softWeight
      const wOther = p.source === 'hard' ? form.scoring.softWeight : form.scoring.hardWeight
      const sides = [
        ...(restMean != null ? [{ v: restMean, w: wSelf }] : []),
        ...(other != null ? [{ v: other, w: wOther }] : []),
      ].filter((x) => x.w > 0)
      const den = sides.reduce((a, x) => a + x.w, 0)
      const totalAfter = den > 0 ? sides.reduce((a, x) => a + x.v * x.w, 0) / den : null
      // offered when it reaches the threshold, or when the result costs the total a lot
      if (
        totalAfter != null &&
        row.total != null &&
        (totalAfter >= form.scoring.acceptThreshold || totalAfter - row.total >= 0.05)
      ) {
        fixes.push({ type: 'weightZero', source: p.source, id: p.id, totalAfter })
      }
    }
  }
  return fixes
}

/** Make the change of a fix on the form. */
export function applyFix(form: SpecForm, fix: Fix, run: { reviewFlags: string[]; rejectFlags: string[] }): void {
  if (fix.type === 'flag') {
    setFlagEffect(form, fix.flag, 'info', run, fix.checkId)
    return
  }
  if (fix.type === 'acceptAt') {
    form.scoring.acceptThreshold = fix.to
    if (form.scoring.reviewThreshold > fix.to) form.scoring.reviewThreshold = Math.max(0, Math.round((fix.to - 0.1) * 100) / 100)
    return
  }
  const target =
    fix.source === 'hard' ? form.hardCritics.find((c) => c.id === fix.id) : form.soft.indicators.find((i) => i.id === fix.id)
  if (!target) return
  if (fix.type === 'liftStop') target.gate = false
  else if (fix.type === 'lowerStop' && fix.to != null) target.gateBelow = fix.to
  else if (fix.type === 'weightZero') target.weight = 0
}

/**
 * The fixes that are needed together for the episode to be accepted: every
 * stop, reject and cap fix, and for the score the threshold (the smallest
 * change that does not drop a result).
 */
export const allFixes = (fixes: Fix[]): Fix[] => fixes.filter((f) => f.type !== 'weightZero')

/** What a set of fixes would do to the sample: every episode whose verdict changes. */
export function fixImpact(
  report: SampleReport,
  form: SpecForm,
  fixes: Fix[],
): { changed: { episode: number; from: Verdict; to: Verdict }[] } {
  const run = runFlags(report)
  const before = previewVerdicts(report, form, run)
  // a plain copy: the form on screen is a reactive proxy, which structuredClone refuses
  const after = JSON.parse(JSON.stringify(form)) as SpecForm
  for (const f of fixes) applyFix(after, f, run)
  const next = previewVerdicts(report, after, run)
  return {
    changed: next.map((r, i) => ({ episode: r.episode, from: before[i]!.verdict, to: r.verdict })).filter((c) => c.from !== c.to),
  }
}
