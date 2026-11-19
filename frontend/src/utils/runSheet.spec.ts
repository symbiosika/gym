import { describe, expect, it } from 'vitest'
import { defaultGroupColumn, groupCount, runSheetTemplate, sheetToCsv } from './runSheet'
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

describe('the run sheet template', () => {
  const rowsOf = (csv: string, sep: string) =>
    csv
      .replace(/^\uFEFF/, '')
      .trim()
      .split('\r\n')
      .map((l) => l.split(sep))

  it('has the columns GYM reads by name and one row per episode, grouped by layout into steps', () => {
    const [header, ...rows] = rowsOf(runSheetTemplate('stack the cups'), ',')
    expect(header).toEqual(['episode', 'layout', 'prompt', 'object', 'start_position', 'arm', 'note'])
    expect(defaultGroupColumn(header!)).toBe('layout')
    expect(rows).toHaveLength(6)
    expect(rows.every((r) => r[2] === 'stack the cups')).toBe(true)
    const sheet = {
      rows: rows.map((r) => Object.fromEntries(header!.map((c, i) => [c, r[i] ?? '']))),
      groupBy: 'layout',
    }
    expect(groupCount(sheet)).toBe(2)
  })

  it('takes a semicolon for a comma-decimal spreadsheet and starts with a byte order mark', () => {
    const csv = runSheetTemplate('', ';')
    expect(csv.startsWith('\uFEFF')).toBe(true)
    expect(rowsOf(csv, ';')[0]).toHaveLength(7)
    expect(rowsOf(csv, ';')[1]![2]).toContain('pick the red cup')
  })
})
