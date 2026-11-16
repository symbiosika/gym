/**
 * The run sheet of a skill, read from the CSV a person keeps.
 *
 * A run sheet lists what to record, one row per episode: which layout, which
 * object, which arm, which prompt, whatever the skill needs. GYM takes it as
 * it is. Only two columns are read by name when they are there, `episode`
 * (the number shown for a row) and `prompt`; one more is picked by the person
 * to group the rows. Everything else is carried along as labelled values and
 * means nothing to GYM, so a column that only makes sense for one skill needs
 * no special handling.
 *
 * The file comes out of a spreadsheet, so the reader takes what spreadsheets
 * write: commas or semicolons, a byte order mark, CRLF, quoted cells with the
 * separator, a line break or a doubled quote inside.
 */
import type { PlanStep, PlanVariation, RunSheet } from "../../db/schema";
import { InvalidInputError } from "./errors";

export const RUN_SHEET_MAX_ROWS = 5000;
export const RUN_SHEET_MAX_COLUMNS = 50;

/** The lines of a CSV as cells, with the line each one started on. Fully empty lines are left out. */
function readCells(text: string, separator: string): { cells: string[]; line: number }[] {
  const out: { cells: string[]; line: number }[] = [];
  let cells: string[] = [];
  let cell = "";
  let quoted = false;
  /** the cell was opened with a quote: it is taken as it is, not trimmed away to nothing */
  let wasQuoted = false;
  let line = 1;
  let startedOn = 1;
  const endCell = () => {
    cells.push(wasQuoted ? cell : cell.trim());
    cell = "";
    wasQuoted = false;
  };
  const endLine = () => {
    endCell();
    if (cells.some((c) => c !== "")) out.push({ cells, line: startedOn });
    cells = [];
    startedOn = line + 1;
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else {
        if (ch === "\n") line++;
        cell += ch;
      }
    } else if (ch === '"' && cell.trim() === "") {
      quoted = true;
      wasQuoted = true;
      cell = "";
    } else if (ch === separator) endCell();
    else if (ch === "\n") {
      endLine();
      line++;
    } else if (ch !== "\r") cell += ch;
  }
  if (quoted) throw new InvalidInputError(`The run sheet has a quote that never closes (line ${startedOn})`);
  endLine();
  return out;
}

/** Semicolons when the header holds more of them than commas, as a spreadsheet in a comma-decimal locale writes it. */
function separatorOf(text: string): string {
  const header = text.slice(0, text.indexOf("\n") === -1 ? text.length : text.indexOf("\n"));
  const count = (ch: string) => header.split(ch).length - 1;
  return count(";") > count(",") ? ";" : ",";
}

/**
 * Read a CSV into a run sheet. A header row is required, no column is: the
 * sheet is the person's. Refused with a reason a person can act on when it is
 * not a table (no rows, a column without a name or named twice, a row longer
 * than the header) or beyond the limits.
 */
export function parseRunSheet(csv: string, fileName: string, groupBy: string | null): RunSheet {
  const text = csv.replace(/^﻿/, "");
  const lines = readCells(text, separatorOf(text.trimStart()));
  const header = lines.shift();
  if (!header) throw new InvalidInputError("The run sheet is empty");
  const columns = header.cells.map((c) => c.trim());
  if (columns.length > RUN_SHEET_MAX_COLUMNS) throw new InvalidInputError(`A run sheet has at most ${RUN_SHEET_MAX_COLUMNS} columns`);
  if (columns.some((c) => !c)) throw new InvalidInputError("Every column of the run sheet needs a name in the first row");
  const twice = columns.find((c, i) => columns.indexOf(c) !== i);
  if (twice) throw new InvalidInputError(`The run sheet has the column "${twice}" twice`);
  if (!lines.length) throw new InvalidInputError("The run sheet has a header but no rows");
  if (lines.length > RUN_SHEET_MAX_ROWS) throw new InvalidInputError(`A run sheet has at most ${RUN_SHEET_MAX_ROWS} rows`);
  if (groupBy != null && !columns.includes(groupBy)) throw new InvalidInputError(`The run sheet has no column "${groupBy}" to group by`);
  const rows = lines.map(({ cells, line }) => {
    if (cells.length > columns.length) throw new InvalidInputError(`The run sheet has more cells than columns in line ${line}`);
    return Object.fromEntries(columns.map((c, i) => [c, cells[i] ?? ""]));
  });
  return { fileName, columns, rows, groupBy, importedAt: new Date().toISOString() };
}

/** The column GYM reads by name, whatever its case in the file; null when the sheet has none. */
export function columnOf(sheet: Pick<RunSheet, "columns">, name: "episode" | "prompt"): string | null {
  return sheet.columns.find((c) => c.toLowerCase() === name) ?? null;
}

/** a variation's label and a field's value are held to what the plan's own schema takes */
const PLAN_TEXT_MAX = 300;

/**
 * The run sheet as the steps of a recording plan. Rows are taken in the order
 * of the sheet; consecutive rows with the same value in the group column form
 * one step, so a group that comes back later is a step of its own and the
 * plan follows the sheet from top to bottom. Each row is one episode: a
 * variation with its number and prompt as the label and every other filled
 * cell as a labelled value. `rowNumbers` picks rows by their place in the
 * sheet, counted from 1; null takes all.
 */
export function planStepsFromRunSheet(sheet: RunSheet, rowNumbers: number[] | null): Omit<PlanStep, "id">[] {
  const episodeColumn = columnOf(sheet, "episode");
  const promptColumn = columnOf(sheet, "prompt");
  const skipped = new Set([sheet.groupBy, episodeColumn, promptColumn]);
  const picked = rowNumbers ? new Set(rowNumbers) : null;
  const steps: (Omit<PlanStep, "id"> & { group: string | null })[] = [];
  sheet.rows.forEach((row, i) => {
    const number = i + 1;
    if (picked && !picked.has(number)) return;
    const group = sheet.groupBy ? (row[sheet.groupBy] ?? "") : null;
    const episode = (episodeColumn && row[episodeColumn]) || String(number);
    const prompt = promptColumn ? row[promptColumn] : "";
    const variation: PlanVariation = {
      label: (prompt ? `${episode} · ${prompt}` : episode).slice(0, PLAN_TEXT_MAX),
      episodes: 1,
      fields: sheet.columns
        .filter((c) => !skipped.has(c) && row[c])
        .map((c) => ({ name: c.slice(0, PLAN_TEXT_MAX), value: row[c]!.slice(0, PLAN_TEXT_MAX) })),
    };
    const last = steps[steps.length - 1];
    if (last && last.group === group) {
      last.variations.push(variation);
      last.episodes += 1;
    } else {
      const title = sheet.groupBy ? `${sheet.groupBy} ${group}`.trim() : sheet.fileName;
      steps.push({ group, title: title.slice(0, PLAN_TEXT_MAX), instructions: "", variations: [variation], episodes: 1 });
    }
  });
  return steps.map(({ group: _group, ...step }) => step);
}
