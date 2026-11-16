import { describe, expect, it } from 'vitest'
import { fmtAxis, metricRows, narrowSelection } from './selectionOverview'
import type { Episode, SelectionMetrics, SelectionView } from '@/types/gym'

const ep = (
  id: string,
  verdict: 'accept' | 'review' | 'reject',
  selected: boolean,
  humanVerdict: 'accept' | 'reject' | null = null,
) => ({ id, verdict, humanVerdict, selected }) as Episode
const view: SelectionView = {
  skillId: 's',
  datasets: [
    {
      dataset: { id: 'a', name: 'A' } as SelectionView['datasets'][number]['dataset'],
      episodes: [ep('1', 'accept', true), ep('2', 'review', false)],
    },
    {
      dataset: { id: 'b', name: 'B' } as SelectionView['datasets'][number]['dataset'],
      episodes: [ep('3', 'reject', false, 'accept')],
    },
  ],
  totals: { episodes: 3, accepted: 2, review: 1, rejected: 0, selected: 1 },
}

describe('one dataset of the selection', () => {
  it('keeps that dataset only and counts it on its own, on the effective verdict', () => {
    const b = narrowSelection(view, 'b')
    expect(b.datasets.map((d) => d.dataset.id)).toEqual(['b'])
    expect(b.totals).toMatchObject({ episodes: 1, accepted: 1, review: 0, rejected: 0, selected: 0 })
    const a = narrowSelection(view, 'a')
    expect(a.totals).toMatchObject({ episodes: 2, accepted: 1, review: 1, rejected: 0, selected: 1 })
  })

  it('is empty for a dataset the selection does not have', () => {
    expect(narrowSelection(view, 'nope')).toMatchObject({ datasets: [], totals: { episodes: 0, selected: 0 } })
  })
})

describe('a position per axis', () => {
  it('writes x / y / z with one decimal, and a dash for nothing', () => {
    expect(fmtAxis([1, 0, -12.345])).toBe('1.0 / 0.0 / -12.3')
    expect(fmtAxis(null)).toBe('–')
    expect(fmtAxis(undefined)).toBe('–')
  })
})

describe('the rows of the position table', () => {
  const stat = (n: number) => ({ n, meanCm: [n, 0, 0] as [number, number, number], stdCm: [0, 0, 0] as [number, number, number] })
  const metrics: SelectionMetrics = {
    datasets: 1,
    episodes: 4,
    withoutPositions: 0,
    pick: { all: stat(4), byArm: { left: stat(2), right: stat(2) } },
    wristStart: { left: stat(4), right: stat(4) },
    wristEnd: { left: stat(4) },
    deltaStart: stat(4),
    deltaEnd: null,
  }

  it('lists picks overall and per arm, then each wrist at the start and the end with the delta between the sides', () => {
    expect(metricRows(metrics).map((r) => [r.group, r.kind, r.arm ?? null])).toEqual([
      ['pick', 'all', null],
      ['pick', 'arm', 'left'],
      ['pick', 'arm', 'right'],
      ['start', 'arm', 'left'],
      ['start', 'arm', 'right'],
      ['start', 'delta', null],
      ['end', 'arm', 'left'],
    ])
  })

  it('leaves the per-arm pick rows out when there is one arm only: they would repeat the overall row', () => {
    const one = { ...metrics, pick: { all: stat(2), byArm: { left: stat(2) } } }
    expect(
      metricRows(one)
        .filter((r) => r.group === 'pick')
        .map((r) => r.kind),
    ).toEqual(['all'])
  })

  it('has no rows when nothing was measured', () => {
    expect(metricRows({ ...metrics, pick: { all: null, byArm: {} }, wristStart: {}, wristEnd: {}, deltaStart: null })).toEqual([])
  })
})
