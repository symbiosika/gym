import { describe, expect, it } from 'vitest'
import { armFromFileName, armOverrides, instructionOverrides, overridesEditable } from './datasetArm'

describe('armFromFileName', () => {
  it('reads the arm out of a session folder name', () => {
    expect(armFromFileName('2026_10_26_13_28_session-right-arm-L0-R0-brown-tube-gel.zip')).toBe('right')
    expect(armFromFileName('session_left_arm_cups')).toBe('left')
    expect(armFromFileName('cup_tray_a.zip')).toBeNull()
    expect(armFromFileName('left-and-right-arm')).toBeNull()
  })
  it('matches case-insensitively and the joined spelling', () => {
    expect(armFromFileName('Session_RightArm_01.zip')).toBe('right')
    expect(armFromFileName('x-LEFT-y.zip')).toBe('left')
  })
})

describe('armOverrides', () => {
  it('maps the choice to the critics field', () => {
    expect(armOverrides('auto')).toBeNull()
    expect(armOverrides('right')).toEqual({ robot: { active_arms: ['right'] } })
    expect(armOverrides('both')).toEqual({ robot: { active_arms: ['left', 'right'] } })
  })
})

describe('instructionOverrides', () => {
  it('adds the instruction and the objects, the first one the target', () => {
    expect(instructionOverrides({ robot: { active_arms: ['left'] } }, '', '')).toEqual({ robot: { active_arms: ['left'] } })
    expect(instructionOverrides(null, '', '')).toBeNull()
    expect(instructionOverrides(null, ' pick the tube ', 'tube\n\ncup\n gel ')).toEqual({
      task: {
        instruction: 'pick the tube',
        objects: [
          { name: 'tube', role: 'target_object' },
          { name: 'cup', role: 'distractor' },
          { name: 'gel', role: 'distractor' },
        ],
      },
    })
  })
})

describe('overridesEditable', () => {
  it('is open only for a waiting zip whose upload has not begun', () => {
    expect(overridesEditable('waiting', undefined)).toBe(true)
    expect(overridesEditable('failed', undefined)).toBe(false)
    expect(overridesEditable('uploading', undefined)).toBe(false)
  })
  it('closes once the upload has an id: a resume takes the overrides stored on the upload', () => {
    expect(overridesEditable('waiting', 'up_1')).toBe(false)
    expect(overridesEditable('failed', 'up_1')).toBe(false)
  })
})
