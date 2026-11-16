import { describe, expect, it } from 'vitest'
import { filterSkills } from './skills'
import type { SkillListItem } from '@/types/gym'

const skill = (name: string, status: 'active' | 'archived', collectionName: string | null = null) =>
  ({ id: name, name, status, collectionName }) as SkillListItem

describe('the skills list', () => {
  const list = [skill('Pick from Shelf', 'active', 'Retail'), skill('Fold towel', 'archived', 'Household')]

  it('finds a skill by a part of its name or of its collection, whatever the case', () => {
    expect(filterSkills(list, 'shelf', null).map((s) => s.name)).toEqual(['Pick from Shelf'])
    expect(filterSkills(list, 'HOUSE', null).map((s) => s.name)).toEqual(['Fold towel'])
  })

  it('keeps only the skills of a status', () => {
    expect(filterSkills(list, '', 'active').map((s) => s.name)).toEqual(['Pick from Shelf'])
  })

  it('leaves the list alone without a filter', () => {
    expect(filterSkills(list, '  ', null)).toEqual(list)
  })
})
