import { reactive } from 'vue'
import type { AxisStat, SelectionMetrics, SelectionPoint } from '@/types/gym'

/**
 * The geometry of the position charts on a skill's Pre-Train tab: which marks
 * to draw for a choice of positions and of a viewing plane, and the scales
 * they are drawn on. Everything is in centimetres, as the figures are.
 *
 * Nothing is computed here that the figures do not already say: the dots are
 * the positions the critics measured, the ellipses and whiskers are the mean
 * and standard deviation GYM's figures carry.
 */

/** pick positions, or the wrists at the start or at the end of the episode */
export type PositionGroup = 'pick' | 'start' | 'end'
/** the two axes looked at: from above (x / y), from the side (x / z), from behind the robot (y / z) */
export type Plane = 'xy' | 'xz' | 'yz'
/**
 * The colour slot of a mark. It follows the arm, never what else is on
 * screen: left and right keep their colour in every chart, the delta between
 * them has its own, and everything without a side is neutral.
 */
export type Series = 'left' | 'right' | 'delta' | 'other'

/**
 * What the reader chose to look at in the position charts. Kept here and not
 * in the chart: the chart is taken down whenever the selection has nothing to
 * draw (a dataset ticked out, the figures being read again) and put up again
 * after, and the choice has to outlive that, as it outlives a change of tab.
 */
export const positionView = reactive<{ group: PositionGroup; plane: Plane }>({ group: 'pick', plane: 'xy' })

export const seriesOf = (arm: string | null | undefined): Series => (arm === 'left' || arm === 'right' ? arm : 'other')

/**
 * How a plane is laid out on the chart, following the robot frame (x forward,
 * y to the left, z up): `a` is the axis along the bottom, `b` the one up the
 * side, and `leftward` says that the bottom axis grows to the left, as the
 * robot's y does when it is looked at from above or from behind.
 */
const PLANES: Record<Plane, { a: 0 | 1 | 2; b: 0 | 1 | 2; labels: [string, string]; leftward: boolean }> = {
  xy: { a: 1, b: 0, labels: ['y', 'x'], leftward: true },
  xz: { a: 0, b: 2, labels: ['x', 'z'], leftward: false },
  yz: { a: 1, b: 2, labels: ['y', 'z'], leftward: true },
}
export const planeOf = (plane: Plane) => PLANES[plane]

export interface ScatterDot {
  x: number
  y: number
  series: Series
  arm: string | null
  datasetId: string
  episode: number
}

const cm = (metres: number) => Math.round(metres * 10000) / 100

/** One dot per measured position of the group, on the plane, in centimetres. */
export function scatterDots(points: SelectionPoint[], group: PositionGroup, plane: Plane): ScatterDot[] {
  const { a, b } = PLANES[plane]
  const dots: ScatterDot[] = []
  for (const p of points) {
    const from = { datasetId: p.datasetId, episode: p.episode }
    if (group === 'pick') {
      for (const g of p.grasps) dots.push({ x: cm(g[a]), y: cm(g[b]), series: seriesOf(p.graspArm), arm: p.graspArm, ...from })
      continue
    }
    for (const [arm, w] of Object.entries(p.wrists)) {
      const at = group === 'start' ? w.start : w.end
      if (at) dots.push({ x: cm(at[a]), y: cm(at[b]), series: seriesOf(arm), arm, ...from })
    }
  }
  return dots
}

/** The figures of a group per arm; for picks without a named arm, the overall one under no arm. */
function statsByArm(m: SelectionMetrics, group: PositionGroup): [string | null, AxisStat][] {
  if (group === 'start') return Object.entries(m.wristStart)
  if (group === 'end') return Object.entries(m.wristEnd)
  const arms = Object.entries(m.pick.byArm)
  if (arms.length > 1) return arms
  return m.pick.all ? [[null, m.pick.all]] : []
}

export interface SpreadEllipse {
  series: Series
  arm: string | null
  /** the mean */
  cx: number
  cy: number
  /** one standard deviation along each axis of the plane */
  rx: number
  ry: number
  n: number
}

/** Mean and one standard deviation per arm on the plane: the cross and the ellipse over the dots. */
export function spreadEllipses(m: SelectionMetrics, group: PositionGroup, plane: Plane): SpreadEllipse[] {
  const { a, b } = PLANES[plane]
  return statsByArm(m, group).map(([arm, s]) => ({
    series: seriesOf(arm),
    arm,
    cx: s.meanCm[a],
    cy: s.meanCm[b],
    rx: s.stdCm[a],
    ry: s.stdCm[b],
    n: s.n,
  }))
}

export interface BarSeries {
  key: string
  series: Series
  arm: string | null
  stat: AxisStat
}

/**
 * The series of the bar chart: mean per axis with its standard deviation,
 * per arm, and for the wrists the delta between the sides (left minus right).
 */
export function barSeries(m: SelectionMetrics, group: PositionGroup): BarSeries[] {
  const out: BarSeries[] = statsByArm(m, group).map(([arm, stat]) => ({ key: arm ?? 'all', series: seriesOf(arm), arm, stat }))
  const delta = group === 'start' ? m.deltaStart : group === 'end' ? m.deltaEnd : null
  if (delta) out.push({ key: 'delta', series: 'delta', arm: null, stat: delta })
  return out
}

/**
 * The domain of the scatter plot: both axes get the same span, so a
 * centimetre is as long across as up and a spread reads as its true shape.
 * It holds every mark with its spread, with a tenth of room around, and never
 * collapses when everything sits on one spot.
 */
export function squareDomain(marks: { x: number; y: number; rx: number; ry: number }[]): {
  x: [number, number]
  y: [number, number]
} {
  if (!marks.length) return { x: [-1, 1], y: [-1, 1] }
  const lo = (k: 'x' | 'y', r: 'rx' | 'ry') => Math.min(...marks.map((m) => m[k] - m[r]))
  const hi = (k: 'x' | 'y', r: 'rx' | 'ry') => Math.max(...marks.map((m) => m[k] + m[r]))
  const [x0, x1, y0, y1] = [lo('x', 'rx'), hi('x', 'rx'), lo('y', 'ry'), hi('y', 'ry')]
  const half = (Math.max(x1 - x0, y1 - y0, 1) * 1.2) / 2
  const [mx, my] = [(x0 + x1) / 2, (y0 + y1) / 2]
  return { x: [mx - half, mx + half], y: [my - half, my + half] }
}

/** Ticks at round numbers (1, 2 or 5 times a power of ten) inside a range, about `count` of them. */
export function niceTicks(min: number, max: number, count: number): number[] {
  if (!(max > min)) return [min]
  const rough = (max - min) / Math.max(1, count)
  const power = 10 ** Math.floor(Math.log10(rough))
  const step = [1, 2, 5, 10].map((f) => f * power).find((s) => s >= rough)!
  const ticks: number[] = []
  for (let t = Math.ceil(min / step) * step; t <= max + step * 1e-9; t += step) ticks.push(Math.round(t / step) * step + 0)
  return ticks.map((t) => Math.round(t * 1e6) / 1e6)
}
