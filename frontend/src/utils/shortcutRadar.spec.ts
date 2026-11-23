import { describe, expect, it } from 'vitest'
import {
  firstBaseline,
  labelPlace,
  radarOutline,
  radarPoint,
  radarPoints,
  radarRing,
  ringLabelPlace,
  twoLines,
} from './shortcutRadar'

const frame = { cx: 100, cy: 100, r: 50 }

describe('spider plot of the shortcut tests', () => {
  it('puts the first axis at the top and goes clockwise, 0 % in the centre and 100 % on the rim', () => {
    expect(radarPoint(frame, 0, 4, 1)).toMatchObject({ x: 100, y: 50 })
    const right = radarPoint(frame, 1, 4, 0.5)
    expect(right.x).toBeCloseTo(125)
    expect(right.y).toBeCloseTo(100)
    expect(radarPoint(frame, 2, 4, 0)).toMatchObject({ x: 100, y: 100 })
    // a share is clamped, never drawn outside the rim
    expect(radarPoint(frame, 0, 4, 1.4).y).toBeCloseTo(50)
  })

  it('closes and fills the outline only when every axis has a value', () => {
    const full = radarOutline(radarPoints(frame, [1, 1, 1, 1]))
    expect(full.closed).toBe(true)
    expect(full.d.endsWith('Z')).toBe(true)

    // the second axis was not testable: no fill, and no line bridges it
    const gap = radarOutline(radarPoints(frame, [1, null, 1, 1]))
    expect(gap.closed).toBe(false)
    expect(gap.d.match(/M/g)).toHaveLength(2)
    expect(gap.d).not.toContain('Z')
    // the last axis neighbours the first
    expect(radarOutline(radarPoints(frame, [1, null, null, 1])).d.match(/M/g)).toHaveLength(1)
    expect(radarOutline(radarPoints(frame, [null, null, null])).d).toBe('')
  })

  it('draws the grid rings through every axis', () => {
    expect(radarRing(frame, 5, 0.5).match(/L/g)).toHaveLength(4)
  })

  it('anchors a label by the side it is on', () => {
    expect(labelPlace(frame, 0, 4).anchor).toBe('middle')
    expect(labelPlace(frame, 1, 4).anchor).toBe('start')
    expect(labelPlace(frame, 3, 4).anchor).toBe('end')
  })

  it('keeps a label clear of the rim and the ring values clear of the top axis', () => {
    const top = labelPlace(frame, 0, 5)
    // two lines at the top: both sit above the rim
    expect(firstBaseline(frame, top, 2) + 13).toBeLessThan(frame.cy - frame.r)
    const bottom = labelPlace(frame, 2, 4)
    expect(firstBaseline(frame, bottom, 2)).toBeGreaterThan(bottom.y)
    // between the first two axes, to the right of the top spoke
    expect(ringLabelPlace(frame, 5, 1).x).toBeGreaterThan(frame.cx + 20)
  })

  it('splits a long label into two lines of about even length', () => {
    expect(twoLines('Grasp position tells prompt')).toEqual(['Grasp position', 'tells prompt'])
    expect(twoLines('First image')).toEqual(['First image'])
  })
})
