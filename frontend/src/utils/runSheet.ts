import type { RunSheet } from '@/types/gym'

/**
 * How many plan steps the sheet becomes: consecutive rows with the same value
 * in the group column are one step, so a group that comes back later counts
 * again. Without a group column the whole sheet is one step.
 */
export function groupCount(sheet: Pick<RunSheet, 'rows' | 'groupBy'>): number {
  if (!sheet.rows.length) return 0
  if (!sheet.groupBy) return 1
  const by = sheet.groupBy
  return sheet.rows.reduce((n, row, i) => (i === 0 || row[by] !== sheet.rows[i - 1]![by] ? n + 1 : n), 0)
}

/** The column a sheet is grouped by unless the person says otherwise: the one called "layout". */
export const defaultGroupColumn = (columns: string[]): string | null => columns.find((c) => c.toLowerCase() === 'layout') ?? null

const cell = (value: string) => (/[",;\n\r]|^\s|\s$/.test(value) ? `"${value.replace(/"/g, '""')}"` : value)

/**
 * The stored sheet as CSV again. The server keeps the rows, not the file, so
 * changing the group column sends the same rows back with another choice.
 */
export const sheetToCsv = (sheet: Pick<RunSheet, 'columns' | 'rows'>): string =>
  [sheet.columns.map(cell).join(','), ...sheet.rows.map((row) => sheet.columns.map((c) => cell(row[c] ?? '')).join(','))].join(
    '\n',
  )
