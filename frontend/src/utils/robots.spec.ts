import { describe, expect, it } from 'vitest'
import { componentCount, copyName, healthIssues, robotFullLabel, robotLabel, sectionChangeLines } from './robots'

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
    const health = { ok: 4, degraded: 2, faulty: 1, disconnected: 3, unknown: 0 }
    expect(healthIssues(health)).toEqual([
      { status: 'faulty', n: 1 },
      { status: 'degraded', n: 2 },
      { status: 'disconnected', n: 3 },
    ])
    expect(componentCount(health)).toBe(10)
  })

  it('has nothing to show for a robot without components', () => {
    const health = { ok: 0, degraded: 0, faulty: 0, disconnected: 0, unknown: 0 }
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

describe('history of the sections', () => {
  it('names the one kind of change, or "updated" when several came together, in section order', () => {
    expect(
      sectionChangeLines({
        system: { added: [], updated: [], removed: ['ROS 1'] },
        sensors: { added: ['Lidar'], updated: [], removed: [] },
        actuators: { added: ['Hand'], updated: ['Gripper'], removed: ['Arm'] },
      }),
    ).toEqual([
      { section: 'sensors', kind: 'added', names: ['Lidar'] },
      { section: 'actuators', kind: 'updated', names: ['Hand', 'Gripper', 'Arm'] },
      { section: 'system', kind: 'removed', names: ['ROS 1'] },
    ])
    expect(sectionChangeLines(undefined)).toEqual([])
  })
})
