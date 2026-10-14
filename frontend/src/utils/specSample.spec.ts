import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { SampleReport } from '@/types/gym'
import { fromSpec } from './spec'
import {
  agreement,
  allFixes,
  applyFix,
  fixesFor,
  fixImpact,
  blockerSummary,
  disagrees,
  resultRows,
  scoresOf,
  countVerdicts,
  indicatorEvidence,
  criticEvidence,
  cycleCounts,
  durationRange,
  flagEffect,
  sampleFlags,
  setFlagEffect,
  metricRange,
  previewVerdicts,
  runFlags,
  sampleTasks,
  softState,
} from './specSample'

/** the report of a real critics run that the backend tests replay: four episodes, two accepted, two rejected */
const report = (): SampleReport =>
  JSON.parse(readFileSync(resolve(__dirname, '../../../backend/src/lib/critics/fixtures/report.json'), 'utf8'))

describe('the sample of the spec wizard', () => {
  it('reads what the data says about the task', () => {
    const r = report()
    expect(sampleTasks(r)).toEqual([{ task: 'put the red block in the box', episodes: 4 }])
    expect(cycleCounts(r).typical).toBe(1)
    expect(cycleCounts(r).perEpisode).toHaveLength(4)
    expect(durationRange(r)!.min).toBeGreaterThan(0)
    expect(metricRange(r, 'duration', 'duration_s')!.n).toBe(4)
    expect(metricRange(r, 'duration', 'nothing')).toBeNull()
    // the run had no vision-language model: it is said, not hidden
    expect(softState(r)).toBe('failed')
  })

  it('sums up every technical check over the sample', () => {
    const ev = criticEvidence(report())
    expect(ev.grasp_cycles!.flags).toEqual({ NOGRASP: 1 })
    expect(ev.grasp_cycles!.gateFailed).toBe(1)
    expect(ev.duplication!.flags).toEqual({ LAGGY: 1 })
    expect(ev.duration!.scored).toBe(4)
    expect(ev.duration!.meanScore).toBe(1)
  })

  it('previews the verdicts of the run with the spec it ran with', () => {
    const r = report()
    const form = fromSpec(r.spec)
    const rows = previewVerdicts(r, form, runFlags(r))
    expect(rows.map((x) => x.verdict)).toEqual(rows.map((x) => x.ranVerdict))
    expect(countVerdicts(rows)).toEqual({ accept: 2, review: 0, reject: 2 })
  })

  it('follows the form: a check switched off, a flag muted, a stricter threshold', () => {
    const r = report()
    const form = fromSpec(r.spec)
    form.hardCritics.find((c) => c.id === 'grasp_cycles')!.enabled = false
    form.scoring.ignoreFlags = ['LAGGY']
    const rows = previewVerdicts(r, form, runFlags(r))
    // episode 3 lost its NOGRASP gate, episode 2 its LAGGY one
    expect(rows.find((x) => x.episode === 3)!.verdict).toBe('accept')
    expect(rows.find((x) => x.episode === 2)!.gates).toEqual([])

    form.scoring.acceptThreshold = 1.01
    form.scoring.reviewThreshold = 0.5
    expect(countVerdicts(previewVerdicts(r, form, runFlags(r)))).toEqual({ accept: 0, review: 4, reject: 0 })
  })

  /** the situation of the scoring step: the model scored "object in target" under its stop on every episode */
  const withModel = (): SampleReport => {
    const r = report()
    r.spec = {
      ...r.spec,
      soft_critics: { indicators: [{ id: 'object_in_target', description: 'The block lies in the box at the end.' }] },
    }
    for (const e of r.episodes) {
      e.soft = [
        {
          id: 'vlm.object_in_target',
          kind: 'soft',
          weight: 2,
          score: e.episode === 0 ? 0.1 : 0.2,
          gate: true,
          gate_below: 0.3,
          gate_failed: true,
          flags: ['VLM_OBJECT_IN_TARGET'],
          metrics: {},
          evidence: [`the block stays next to the box in episode ${e.episode}`],
          error: null,
        },
      ]
    }
    return r
  }
  const modelForm = (r: SampleReport) => {
    const form = fromSpec(r.spec)
    form.soft.indicators[0]!.gate = true
    form.soft.indicators[0]!.gateBelow = 0.3
    form.soft.indicators[0]!.weight = 2
    return form
  }

  it('says that a stop of a success criterion holds the episodes, not the thresholds', () => {
    const r = withModel()
    const form = modelForm(r)
    form.scoring.acceptThreshold = 0.05
    form.scoring.reviewThreshold = 0
    const rows = previewVerdicts(r, form, runFlags(r))
    expect(countVerdicts(rows).accept).toBe(0)
    const [first] = blockerSummary(rows)
    expect(first!.blocker).toMatchObject({ kind: 'gate', source: 'soft', id: 'object_in_target', limit: 0.3 })
    expect(first!.episodes).toEqual([0, 1, 2, 3])
    expect(first!.scores).toEqual([0.1, 0.2, 0.2, 0.2])
    // what the model saw is carried along, and kept per criterion for the success step
    expect(rows[0]!.blockers[0]).toMatchObject({ evidence: 'the block stays next to the box in episode 0' })
    expect(indicatorEvidence(r).object_in_target!.judgedText).toBe('The block lies in the box at the end.')
  })

  it('lets the episodes through once the stop is lowered or lifted', () => {
    const r = withModel()
    const form = modelForm(r)
    form.soft.indicators[0]!.gateBelow = 0.05
    const lowered = previewVerdicts(r, form, runFlags(r))
    expect(lowered.flatMap((x) => x.blockers).some((b) => b.kind === 'gate' && b.source === 'soft')).toBe(false)
    form.soft.indicators[0]!.gate = false
    const lifted = previewVerdicts(r, form, runFlags(r))
    // what is left is the score: the model's low marks pull the total down
    expect(blockerSummary(lifted).every((g) => g.blocker.kind !== 'gate' || g.blocker.source === 'hard')).toBe(true)
  })

  it('names the score as the reason only when nothing stops the episode', () => {
    const r = report()
    const form = fromSpec(r.spec)
    form.scoring.acceptThreshold = 1.01
    const rows = previewVerdicts(r, form, runFlags(r))
    const accepted = rows.filter((x) => x.ranVerdict === 'accept')
    expect(accepted.every((x) => x.blockers.length === 1 && x.blockers[0]!.kind === 'score')).toBe(true)
    // the stops come first in the summary
    expect(blockerSummary(rows)[0]!.blocker.kind).toBe('gate')
  })
})

describe('the flags of the sample', () => {
  const sample = (): SampleReport => {
    const r = JSON.parse(
      readFileSync(resolve(__dirname, '../../../backend/src/lib/critics/fixtures/report.json'), 'utf8'),
    ) as SampleReport
    r.flag_docs = { LAGGY: 'command vector frozen', NOGRASP: 'the gripper never closed' }
    r.spec = { ...r.spec, scoring: { ...(r.spec.scoring as object), review_flags: ['VLM_TASK_FAILED'] } }
    // the model's overall word on episode 0: the task failed
    r.episodes[0]!.soft = [
      {
        id: 'vlm.summary',
        kind: 'soft',
        weight: 0,
        score: 0,
        gate: false,
        gate_below: 0,
        gate_failed: false,
        flags: ['VLM_TASK_FAILED'],
        metrics: { anomalies: [{ description: 'the cup falls off the tray' }] },
        evidence: [],
        error: null,
      },
    ]
    return r
  }

  it('lists every flag with its source, meaning, episodes and effect', () => {
    const r = sample()
    const flags = sampleFlags(r, fromSpec(r.spec))
    expect(flags[0]).toMatchObject({ flag: 'VLM_TASK_FAILED', source: 'vlm', episodes: [0], effect: 'review' })
    expect(flags[0]!.evidence).toEqual([{ episode: 0, text: 'the cup falls off the tray' }])
    expect(flags.find((f) => f.flag === 'NOGRASP')).toMatchObject({
      source: 'check',
      criticId: 'grasp_cycles',
      effect: 'stop',
      meaning: 'the gripper never closed',
    })
  })

  it('takes the model summary into the preview: a failed task holds an accepted episode at review', () => {
    const r = sample()
    const rows = previewVerdicts(r, fromSpec(r.spec), runFlags(r))
    expect(rows.find((x) => x.episode === 0)!.verdict).toBe('review')
  })

  it('switches a flag on purpose, and the preview follows', () => {
    const r = sample()
    const form = fromSpec(r.spec)
    const run = runFlags(r)
    setFlagEffect(form, 'VLM_TASK_FAILED', 'ignore', run)
    expect(form.scoring.ignoreFlags).toEqual(['VLM_TASK_FAILED'])
    expect(form.scoring.reviewFlags).toEqual([])
    expect(previewVerdicts(r, form, run).find((x) => x.episode === 0)!.verdict).toBe('accept')

    setFlagEffect(form, 'VLM_TASK_FAILED', 'reject', run)
    expect(form.scoring.ignoreFlags).toEqual([])
    expect(form.scoring.rejectFlags).toEqual(['VLM_TASK_FAILED'])
    expect(previewVerdicts(r, form, run).find((x) => x.episode === 0)!.verdict).toBe('reject')

    // a check's stop on a flag is a gate flag of that check; "note only" lifts it
    setFlagEffect(form, 'NOGRASP', 'info', run, 'grasp_cycles')
    expect(form.hardCritics.find((c) => c.id === 'grasp_cycles')!.gateFlags).not.toContain('NOGRASP')
    expect(flagEffect('NOGRASP', form, run, 'grasp_cycles')).toBe('info')
    expect(previewVerdicts(r, form, run).find((x) => x.episode === 3)!.verdict).toBe('accept')
  })
})

describe('the workbench', () => {
  it('shows every result of an episode against the form as it stands', () => {
    const r = report()
    const form = fromSpec(r.spec)
    const rows = resultRows(r, form, 3)
    const grasp = rows.find((x) => x.kind === 'check' && x.id === 'grasp_cycles')!
    expect(grasp).toMatchObject({ score: 0, stopped: true, enabled: true })
    expect(grasp.flags).toEqual([{ flag: 'NOGRASP', effect: 'stop' }])
    // switched off in the form, it neither stops nor counts
    form.hardCritics.find((c) => c.id === 'grasp_cycles')!.enabled = false
    expect(resultRows(r, form, 3).find((x) => x.id === 'grasp_cycles')).toMatchObject({ enabled: false, stopped: false })
    expect(resultRows(r, form, 99)).toEqual([])
  })

  it('compares the spec with the person and gives the dots of a slider', () => {
    const r = report()
    const rows = previewVerdicts(r, fromSpec(r.spec), runFlags(r))
    // the person says 2 is good and 0 is bad: the spec rejects 2 and accepts 0
    expect(agreement(rows, { '0': 'reject', '1': 'accept', '2': 'accept' })).toEqual({ judged: 3, agree: 1, differ: [0, 2] })
    expect(disagrees('review', 'accept')).toBe(true)
    expect(disagrees('review', 'reject')).toBe(false)
    expect(disagrees('accept', undefined)).toBe(false)
    expect(scoresOf(r, 'check', 'duplication').map((d) => d.episode)).toEqual([0, 1, 2, 3])
    expect(scoresOf(r, 'criterion', 'object_in_target')).toEqual([])
  })
})

describe('how a verdict comes about, and the way to accept', () => {
  it('splits the total into what each result costs it', () => {
    const r = report()
    for (const row of previewVerdicts(r, fromSpec(r.spec), runFlags(r))) {
      const cost = [...row.hardParts, ...row.softParts].reduce((a, p) => a + p.cost, 0)
      expect(1 - cost).toBeCloseTo(row.total!, 6)
    }
  })

  it('gives the calculation: the sums of each side, what is left out, the rule that decided', () => {
    const r = report()
    const form = fromSpec(r.spec)
    form.hardCritics.find((c) => c.id === 'duration')!.weight = 0
    form.hardCritics.find((c) => c.id === 'grasp_cycles')!.enabled = false
    for (const row of previewVerdicts(r, form, runFlags(r))) {
      // hard = Σ w·s / Σ w over the parts shown
      const sumW = row.hardParts.reduce((a, p) => a + p.weight, 0)
      const sumWS = row.hardParts.reduce((a, p) => a + p.weight * p.score, 0)
      expect(row.hard).toBeCloseTo(sumWS / sumW, 9)
      expect(row.skipped).toEqual(
        expect.arrayContaining([
          { source: 'hard', id: 'duration', reason: 'weight0' },
          { source: 'hard', id: 'grasp_cycles', reason: 'off' },
        ]),
      )
      expect(row.sideWeights.soft).toBe(row.soft == null ? 0 : form.scoring.softWeight)
      const expected = row.gates.length
        ? 'stop'
        : row.rejects.length
          ? 'rejectFlag'
          : row.total! >= form.scoring.acceptThreshold
            ? row.caps.length
              ? 'cap'
              : 'accept'
            : row.total! >= form.scoring.reviewThreshold
              ? 'review'
              : 'belowReview'
      expect(row.decidedBy).toBe(expected)
    }
  })

  it('finds the change that lets a stopped episode through, and what else it moves', () => {
    const r = report()
    const form = fromSpec(r.spec)
    const run = runFlags(r)
    const row = previewVerdicts(r, form, run).find((x) => x.episode === 3)!
    expect(row.verdict).toBe('reject')
    const fixes = fixesFor(row, form)
    expect(fixes[0]).toEqual({ type: 'flag', flag: 'NOGRASP', checkId: 'grasp_cycles' })
    // the change touches no other episode of this sample
    expect(fixImpact(r, form, [fixes[0]!]).changed).toEqual([{ episode: 3, from: 'reject', to: 'accept' }])
    for (const f of allFixes(fixes)) applyFix(form, f, run)
    expect(previewVerdicts(r, form, run).find((x) => x.episode === 3)!.verdict).toBe('accept')
  })

  it('offers the threshold, or dropping what costs most, when the score is short', () => {
    const r = report()
    const form = fromSpec(r.spec)
    const run = runFlags(r)
    form.scoring.acceptThreshold = 1.01
    const row = previewVerdicts(r, form, run).find((x) => x.episode === 0)!
    expect(row.verdict).not.toBe('accept')
    const fixes = fixesFor(row, form)
    const at = fixes.find((f) => f.type === 'acceptAt')!
    applyFix(form, at, run)
    expect(previewVerdicts(r, form, run).find((x) => x.episode === 0)!.verdict).toBe('accept')
    expect(form.scoring.reviewThreshold).toBeLessThanOrEqual(form.scoring.acceptThreshold)
  })

  it('names a flag that caps at review, and lets it go', () => {
    const r = report()
    r.spec = { ...r.spec, scoring: { ...(r.spec.scoring as object), review_flags: ['VLM_TASK_FAILED'] } }
    r.episodes[0]!.soft = [
      {
        id: 'vlm.summary',
        kind: 'soft',
        weight: 0,
        score: 0,
        gate: false,
        gate_below: 0,
        gate_failed: false,
        flags: ['VLM_TASK_FAILED'],
        metrics: {},
        evidence: [],
        error: null,
      },
    ]
    const form = fromSpec(r.spec)
    const run = runFlags(r)
    const row = previewVerdicts(r, form, run).find((x) => x.episode === 0)!
    expect(row).toMatchObject({ verdict: 'review', scoreVerdict: 'accept', caps: ['VLM_TASK_FAILED'] })
    const [fix] = fixesFor(row, form)
    expect(fix).toEqual({ type: 'flag', flag: 'VLM_TASK_FAILED', checkId: null })
    applyFix(form, fix!, run)
    expect(previewVerdicts(r, form, run).find((x) => x.episode === 0)!.verdict).toBe('accept')
  })
})
