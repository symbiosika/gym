import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { SampleReport } from '@/types/gym'
import { fromSpec } from './spec'
import {
  blockerSummary,
  countVerdicts,
  indicatorEvidence,
  criticEvidence,
  cycleCounts,
  durationRange,
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
