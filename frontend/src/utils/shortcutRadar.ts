/**
 * The geometry of the spider plot over the shortcut tests: one axis per test,
 * clockwise from the top, the centre 0 % and the rim 100 %. A share is placed
 * on its axis as it is; nothing is judged here (the critics say what is a
 * finding, and their flags are what the chart marks).
 *
 * A test that could not be run (one class, one scene) has no point. Its axis
 * stays, the outline only joins neighbouring axes that both have a value, and
 * there is no fill then: a shape bridging a missing axis would draw a value
 * that was never measured.
 */

export interface Point {
  x: number
  y: number
}

export interface RadarFrame {
  cx: number
  cy: number
  /** radius of the 100 % ring */
  r: number
}

/** the angle of axis `i` of `n`, in radians: the first one points up, then clockwise */
export const axisAngle = (i: number, n: number): number => -Math.PI / 2 + (2 * Math.PI * i) / n

/** where a share (0..1, clamped) lies on axis `i` of `n` */
export function radarPoint(frame: RadarFrame, i: number, n: number, share: number): Point {
  const v = Math.min(1, Math.max(0, share))
  const a = axisAngle(i, n)
  return { x: frame.cx + Math.cos(a) * frame.r * v, y: frame.cy + Math.sin(a) * frame.r * v }
}

/** one point per axis, null where the axis has no value */
export function radarPoints(frame: RadarFrame, values: (number | null | undefined)[]): (Point | null)[] {
  return values.map((v, i) => (v == null || Number.isNaN(v) ? null : radarPoint(frame, i, values.length, v)))
}

const p = (pt: Point) => `${pt.x.toFixed(1)},${pt.y.toFixed(1)}`

/**
 * The outline through the points. Closed (and fillable) when every axis has a
 * point; otherwise one segment per pair of neighbouring axes that both have
 * one, the last axis neighbouring the first.
 */
export function radarOutline(points: (Point | null)[]): { d: string; closed: boolean } {
  const n = points.length
  if (n >= 3 && points.every(Boolean)) {
    return { d: `M${points.map((pt) => p(pt!)).join(' L')} Z`, closed: true }
  }
  const segments: string[] = []
  for (let i = 0; i < n; i++) {
    const a = points[i]
    const b = points[(i + 1) % n]
    if (n > 1 && a && b && (i + 1) % n !== i) segments.push(`M${p(a)} L${p(b)}`)
  }
  return { d: segments.join(' '), closed: false }
}

/** a ring of the grid at a share, as a closed polygon through every axis */
export function radarRing(frame: RadarFrame, n: number, share: number): string {
  return `M${Array.from({ length: n }, (_, i) => p(radarPoint(frame, i, n, share))).join(' L')} Z`
}

/** where the label of axis `i` goes, a little outside the rim, and how it is anchored */
export function labelPlace(frame: RadarFrame, i: number, n: number, gap = 14): Point & { anchor: 'start' | 'middle' | 'end' } {
  const a = axisAngle(i, n)
  const x = frame.cx + Math.cos(a) * (frame.r + gap)
  const y = frame.cy + Math.sin(a) * (frame.r + gap)
  const c = Math.cos(a)
  return { x, y, anchor: Math.abs(c) < 0.2 ? 'middle' : c > 0 ? 'start' : 'end' }
}

/** a label in at most two lines of about even length, split between words */
export function twoLines(label: string): string[] {
  const words = label.split(/\s+/).filter(Boolean)
  if (words.length < 3) return [words.join(' ')]
  let best = 1
  let bestDiff = Infinity
  for (let k = 1; k < words.length; k++) {
    const diff = Math.abs(words.slice(0, k).join(' ').length - words.slice(k).join(' ').length)
    if (diff < bestDiff) [best, bestDiff] = [k, diff]
  }
  return [words.slice(0, best).join(' '), words.slice(best).join(' ')]
}

/** the baseline of a label's first line: above the rim at the top, below it at the bottom, centred beside it at the sides */
export function firstBaseline(
  frame: RadarFrame,
  place: Point & { anchor: 'start' | 'middle' | 'end' },
  lines: number,
  lineHeight = 13,
): number {
  if (place.anchor === 'middle' && place.y < frame.cy) return place.y - 2 - (lines - 1) * lineHeight
  if (place.anchor === 'middle') return place.y + 9
  return place.y + 4 - ((lines - 1) * lineHeight) / 2
}

/** where the value of a grid ring is written: between the first two axes, clear of every label */
export function ringLabelPlace(frame: RadarFrame, n: number, share: number): Point {
  const a = axisAngle(0.5, n)
  return { x: frame.cx + Math.cos(a) * frame.r * share + 3, y: frame.cy + Math.sin(a) * frame.r * share - 3 }
}
