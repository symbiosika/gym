import { describe, expect, it } from 'vitest'
import { componentCount, copyName, healthIssues, robotFullLabel, robotLabel } from './robots'

describe('robot names', () => {
  it('uses the personal name first, the technical one without it', () => {
    expect(robotLabel({ personalName: 'Mia', technicalName: 'MAiRA 001' })).toBe('Mia')
    expect(robotLabel({ personalName: '', technicalName: 'MAiRA 001' })).toBe('MAiRA 001')
    expect(robotFullLabel({ personalName: 'Mia', technicalName: 'MAiRA 001' })).toBe('Mia (MAiRA 001)')
    expect(robotFullLabel({ personalName: '', technicalName: 'MAiRA 001' })).toBe('MAiRA 001')
  })
})

describe('robot health', () => {
  it('lists what needs a look, worst first, and leaves ok out', () => {
    const health = { ok: 4, degraded: 2, faulty: 1, unknown: 0 }
    expect(healthIssues(health)).toEqual([
      { status: 'faulty', n: 1 },
      { status: 'degraded', n: 2 },
    ])
    expect(componentCount(health)).toBe(7)
  })

  it('has nothing to show for a robot without components', () => {
    const health = { ok: 0, degraded: 0, faulty: 0, unknown: 0 }
    expect(healthIssues(health)).toEqual([])
    expect(componentCount(health)).toBe(0)
  })
})

describe('copy names', () => {
  it('adds "copy 1", or the next free number', () => {
    expect(copyName('Cam', ['Cam'])).toBe('Cam copy 1')
    expect(copyName('Cam', ['Cam', 'Cam copy 1'])).toBe('Cam copy 2')
    expect(copyName('Cam', ['Cam', 'Cam copy 2'])).toBe('Cam copy 1')
  })
  it('counts a copy of a copy on from the original', () => {
    expect(copyName('Cam copy 1', ['Cam', 'Cam copy 1'])).toBe('Cam copy 2')
  })
})
