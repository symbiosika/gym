import { describe, expect, it } from 'vitest'
import { barSeries, niceTicks, planeOf, scatterDots, seriesOf, spreadEllipses, squareDomain } from './positionChart'
import type { SelectionMetrics, SelectionPoint } from '@/types/gym'

const stat = (mean: [number, number, number], std: [number, number, number], n = 2) => ({ n, meanCm: mean, stdCm: std })
const points: SelectionPoint[] = [
  {
    datasetId: 'a',
    episode: 0,
    graspArm: 'left',
    grasps: [[0.1, 0.2, 0.3]],
    wrists: { left: { start: [0, 0.1, 0.5], end: [0.1, 0.1, 0.5] }, right: { start: [0, -0.1, 0.5], end: null } },
  },
  {
    datasetId: 'a',
    episode: 1,
    graspArm: 'right',
    grasps: [
      [0.3, -0.2, 0.3],
      [0.31, -0.2, 0.3],
    ],
    wrists: {},
  },
  { datasetId: 'b', episode: 4, graspArm: null, grasps: [[0.2, 0, 0.3]], wrists: {} },
]
const metrics: SelectionMetrics = {
  datasets: 2,
  episodes: 3,
  withoutPositions: 1,
  pick: {
    all: stat([20, 0, 30], [8, 16, 0], 4),
    byArm: { left: stat([10, 20, 30], [1, 2, 0], 1), right: stat([30.5, -20, 30], [0.5, 0, 0]) },
  },
  wristStart: { left: stat([0, 10, 50], [0, 0, 0], 1), right: stat([0, -10, 50], [0, 0, 0], 1) },
  wristEnd: { left: stat([10, 10, 50], [0, 0, 0], 1) },
  deltaStart: stat([0, 20, 0], [0, 0, 0], 1),
  deltaEnd: null,
}

describe('which series a mark belongs to', () => {
  it('gives left and right their own colour slot and everything else the neutral one, whatever is on screen', () => {
    expect(seriesOf('left')).toBe('left')
    expect(seriesOf('right')).toBe('right')
    expect(seriesOf(null)).toBe('other')
    expect(seriesOf('arm')).toBe('other')
  })
})

describe('the dots of the scatter plot', () => {
  it('draws every grasp in centimetres on the chosen plane, with the arm that grasped and where it is from', () => {
    const dots = scatterDots(points, 'pick', 'xy')
    expect(dots).toHaveLength(4)
    // from above the robot's x runs up the chart and its y along the bottom
    expect(dots[0]).toEqual({ x: 20, y: 10, series: 'left', arm: 'left', datasetId: 'a', episode: 0 })
    expect(dots[3]).toMatchObject({ x: 0, y: 20, series: 'other', arm: null, datasetId: 'b', episode: 4 })
    expect(scatterDots(points, 'pick', 'xz')[0]).toMatchObject({ x: 10, y: 30 })
    expect(scatterDots(points, 'pick', 'yz')[0]).toMatchObject({ x: 20, y: 30 })
  })

  it('draws each wrist of an episode at the start or the end, and leaves out what has no position', () => {
    expect(scatterDots(points, 'start', 'xy').map((d) => [d.arm, d.x, d.y])).toEqual([
      ['left', 10, 0],
      ['right', -10, 0],
    ])
    expect(scatterDots(points, 'end', 'xy').map((d) => d.arm)).toEqual(['left'])
  })

  it('lays a plane out as the robot frame has it: x forward is up, y grows to the left, z is up', () => {
    // from above: y along the bottom, growing to the robot's left, x up the side
    expect(planeOf('xy')).toEqual({ a: 1, b: 0, labels: ['y', 'x'], leftward: true })
    // from the side: x along the bottom, z up
    expect(planeOf('xz')).toEqual({ a: 0, b: 2, labels: ['x', 'z'], leftward: false })
    // from behind the robot: y along the bottom, growing to the left as from above, z up
    expect(planeOf('yz')).toEqual({ a: 1, b: 2, labels: ['y', 'z'], leftward: true })
  })
})

describe('the spread drawn around the mean', () => {
  it('is one ellipse per arm: the mean as its centre, one standard deviation per axis as its radii', () => {
    expect(spreadEllipses(metrics, 'pick', 'xy')).toEqual([
      { series: 'left', arm: 'left', cx: 20, cy: 10, rx: 2, ry: 1, n: 1 },
      { series: 'right', arm: 'right', cx: -20, cy: 30.5, rx: 0, ry: 0.5, n: 2 },
    ])
  })

  it('is the overall one when no arm is named, and none without a figure', () => {
    const noArms = { ...metrics, pick: { all: stat([20, 0, 30], [8, 16, 0], 4), byArm: {} } }
    expect(spreadEllipses(noArms, 'pick', 'xz')).toEqual([{ series: 'other', arm: null, cx: 20, cy: 30, rx: 8, ry: 0, n: 4 }])
    expect(spreadEllipses(metrics, 'end', 'xy').map((e) => e.arm)).toEqual(['left'])
    expect(spreadEllipses({ ...metrics, wristEnd: {} }, 'end', 'xy')).toEqual([])
  })
})

describe('the bars', () => {
  it('are one series per arm with mean and standard deviation per axis, and the delta between the sides for the wrists', () => {
    expect(barSeries(metrics, 'start').map((s) => s.key)).toEqual(['left', 'right', 'delta'])
    expect(barSeries(metrics, 'start')[2]).toEqual({ key: 'delta', series: 'delta', arm: null, stat: metrics.deltaStart })
    expect(barSeries(metrics, 'end').map((s) => s.key)).toEqual(['left'])
    expect(barSeries(metrics, 'pick').map((s) => [s.key, s.series])).toEqual([
      ['left', 'left'],
      ['right', 'right'],
    ])
  })

  it('are the overall figure for picks when at most one arm is named', () => {
    const one = { ...metrics, pick: { all: metrics.pick.all, byArm: {} } }
    expect(barSeries(one, 'pick').map((s) => [s.key, s.series])).toEqual([['all', 'other']])
  })
})

describe('the scales', () => {
  it('give both axes of the scatter the same span, so a centimetre is as long across as up, with room around the marks', () => {
    const d = squareDomain([
      { x: 0, y: 0, rx: 0, ry: 0 },
      { x: 40, y: 10, rx: 0, ry: 0 },
    ])
    expect(d.x[1] - d.x[0]).toBeCloseTo(d.y[1] - d.y[0])
    expect(d.x[0]).toBeLessThan(0)
    expect(d.x[1]).toBeGreaterThan(40)
    expect((d.y[0] + d.y[1]) / 2).toBeCloseTo(5)
  })

  it('include the spread around a mean, and never collapse to nothing', () => {
    const d = squareDomain([{ x: 10, y: 10, rx: 30, ry: 0 }])
    expect(d.x[0]).toBeLessThanOrEqual(-20)
    expect(d.x[1]).toBeGreaterThanOrEqual(40)
    const flat = squareDomain([{ x: 5, y: 5, rx: 0, ry: 0 }])
    expect(flat.x[1] - flat.x[0]).toBeGreaterThan(0)
    expect(squareDomain([]).x[1]).toBeGreaterThan(squareDomain([]).x[0])
  })

  it('tick at round numbers inside the range', () => {
    expect(niceTicks(0, 40, 5)).toEqual([0, 10, 20, 30, 40])
    expect(niceTicks(-12, 12, 5)).toEqual([-10, -5, 0, 5, 10])
    expect(niceTicks(3, 3, 5)).toEqual([3])
  })
})
