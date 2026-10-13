import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { SampleReport } from '@/types/gym'
import { fromSpec } from './spec'
import {
  countVerdicts,
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
})
