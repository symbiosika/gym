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

/**
 * A run sheet to fill in outside GYM and upload again, laid out the way it
 * becomes a recording plan: one row per episode; `episode` and `prompt` are
 * the columns GYM reads by name (the number and the words of a variation);
 * `layout`, the column a new sheet is grouped by, makes the plan steps, one per
 * run of rows with the same layout; every other column comes along as a
 * labelled value of the episode (object, start position, arm, note here, any
 * other the skill needs). Rename, add or remove those freely.
 *
 * `separator` is a semicolon for a spreadsheet in a comma-decimal locale
 * (German Excel opens a comma file in one column); the reader takes either.
 * The byte order mark makes Excel read the file as UTF-8.
 */
export function runSheetTemplate(prompt: string, separator: ',' | ';' = ','): string {
  const task = prompt.trim() || 'pick the red cup from the shelf and place it on the tray'
  const columns = ['episode', 'layout', 'prompt', 'object', 'start_position', 'arm', 'note']
  const rows = [
    ['1', 'A', task, 'red cup', 'shelf top left', 'right', 'reference setup'],
    ['2', 'A', task, 'red cup', 'shelf top right', 'right', ''],
    ['3', 'A', task, 'red cup', 'shelf bottom left', 'left', ''],
    ['4', 'B', task, 'blue cup', 'shelf top left', 'right', 'other object, same scene'],
    ['5', 'B', task, 'blue cup', 'shelf bottom right', 'left', ''],
    ['6', 'B', task, 'blue cup', 'shelf middle', 'right', 'dim light'],
  ]
  const line = (cells: string[]) => cells.map(cell).join(separator)
  return '\uFEFF' + [line(columns), ...rows.map(line)].join('\r\n') + '\r\n'
}
