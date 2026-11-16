import { describe, expect, it } from 'vitest'
import { defaultGroupColumn, groupCount, sheetToCsv } from './runSheet'
import type { RunSheet } from '@/types/gym'

const sheet: RunSheet = {
  fileName: 's.csv',
  columns: ['episode', 'layout', 'empty_fronts', 'note'],
  rows: [
    { episode: '1', layout: 'A', empty_fronts: '1F,2F', note: 'says "hi"' },
    { episode: '2', layout: 'A', empty_fronts: '', note: 'two\nlines' },
    { episode: '3', layout: 'B', empty_fronts: '4F', note: '' },
    { episode: '4', layout: 'A', empty_fronts: '4F', note: '' },
  ],
  groupBy: 'layout',
  importedAt: '',
}

describe('the run sheet in the strategy tab', () => {
  it('counts the groups as the plan will have steps: a group that comes back counts again', () => {
    expect(groupCount(sheet)).toBe(3)
    expect(groupCount({ ...sheet, groupBy: null })).toBe(1)
    expect(groupCount({ ...sheet, rows: [] })).toBe(0)
  })

  it('proposes the layout column to group by, whatever its case, else none', () => {
    expect(defaultGroupColumn(['episode', 'Layout', 'arm'])).toBe('Layout')
    expect(defaultGroupColumn(['episode', 'arm'])).toBeNull()
  })

  it('writes the stored rows back as a CSV the server reads the same way', () => {
    expect(sheetToCsv(sheet)).toBe(
      ['episode,layout,empty_fronts,note', '1,A,"1F,2F","says ""hi"""', '2,A,,"two\nlines"', '3,B,4F,', '4,A,4F,'].join('\n'),
    )
  })

  it('quotes a cell that would lose its spaces or be read as another separator', () => {
    expect(sheetToCsv({ ...sheet, columns: ['a;b', 'c'], rows: [{ 'a;b': ' x ', c: '1' }] })).toBe('"a;b",c\n" x ",1')
  })
})
