/**
 * The run sheet of a skill: a CSV as a person keeps it, read into rows.
 *   bun run test:local ./src/lib/gym/run-sheet.test.ts
 */
import { describe, expect, test } from "bun:test";
import { InvalidInputError } from "./errors";
import { columnOf, parseRunSheet, planStepsFromRunSheet, RUN_SHEET_MAX_COLUMNS, RUN_SHEET_MAX_ROWS } from "./run-sheet";

/** the first rows of a real sheet: one row per episode, a layout every few rows, a quoted cell with a comma */
const EXAMPLE = [
  "episode,layout,background,target_code,target,position,arm,empty_fronts,recorded_prompt,prompt",
  "1,1,1,T,brown tube gel,1F,left,4F,pick the object from the shelf,pick the brown tube gel from the shelf",
  "2,1,1,G,pink shower gel,4B,right,4F,pick the object from the shelf,pick the pink shower gel from the shelf",
  '6,2,1,J,yellow hair care jar,3F,right,"1F,2F",pick the object from the shelf,pick the yellow hair care jar from the shelf',
].join("\n");

const refused = (csv: string, groupBy: string | null = null) => expect(() => parseRunSheet(csv, "sheet.csv", groupBy)).toThrow(InvalidInputError);

describe("parseRunSheet", () => {
  test("a sheet as it is kept: every column a string, a quoted comma stays in its cell", () => {
    const sheet = parseRunSheet(EXAMPLE, "Pick_from_Shelf_v4.csv", "layout");
    expect(sheet.fileName).toBe("Pick_from_Shelf_v4.csv");
    expect(sheet.columns).toHaveLength(10);
    expect(sheet.columns[0]).toBe("episode");
    expect(sheet.rows).toHaveLength(3);
    expect(sheet.rows[0]).toMatchObject({ episode: "1", layout: "1", arm: "left", empty_fronts: "4F" });
    expect(sheet.rows[2]!.empty_fronts).toBe("1F,2F");
    expect(sheet.groupBy).toBe("layout");
    expect(sheet.importedAt).toBeTruthy();
  });

  test("a sheet out of a spreadsheet: byte order mark, semicolons, CRLF, empty lines at the end", () => {
    const sheet = parseRunSheet('﻿a;b\r\n1;"x;y"\r\n\r\n', "s.csv", null);
    expect(sheet.columns).toEqual(["a", "b"]);
    expect(sheet.rows).toEqual([{ a: "1", b: "x;y" }]);
    expect(sheet.groupBy).toBeNull();
  });

  test("a doubled quote inside a quoted cell is one quote, a line break inside it stays", () => {
    const sheet = parseRunSheet('a,b\n1,"he said ""hi"""\n2,"two\nlines"', "s.csv", null);
    expect(sheet.rows[0]!.b).toBe('he said "hi"');
    expect(sheet.rows[1]!.b).toBe("two\nlines");
  });

  test("cells and header names are trimmed, a short row is filled with empty cells", () => {
    const sheet = parseRunSheet(" a , b ,c\n 1 ,2\n", "s.csv", null);
    expect(sheet.columns).toEqual(["a", "b", "c"]);
    expect(sheet.rows).toEqual([{ a: "1", b: "2", c: "" }]);
  });

  test("a row with more cells than the header is refused with its line", () => {
    expect(() => parseRunSheet("a,b\n1,2\n1,2,3", "s.csv", null)).toThrow(/line 3/);
  });

  test("what is not a sheet is refused", () => {
    refused("");
    refused("   \n");
    refused("a,b"); // a header and nothing under it
    refused("a,,b\n1,2,3"); // a column without a name
    refused("a,a\n1,2"); // the same name twice
    refused('a,b\n1,"open'); // a quote that never closes
    refused("a,b\n1,2", "nope"); // grouped by a column the sheet does not have
  });

  test("the limits: rows and columns", () => {
    const rows = (n: number) => ["a", ...Array.from({ length: n }, (_, i) => String(i))].join("\n");
    expect(parseRunSheet(rows(RUN_SHEET_MAX_ROWS), "s.csv", null).rows).toHaveLength(RUN_SHEET_MAX_ROWS);
    refused(rows(RUN_SHEET_MAX_ROWS + 1));
    const header = (n: number) => Array.from({ length: n }, (_, i) => `c${i}`).join(",");
    expect(parseRunSheet(`${header(RUN_SHEET_MAX_COLUMNS)}\n1`, "s.csv", null).columns).toHaveLength(RUN_SHEET_MAX_COLUMNS);
    refused(`${header(RUN_SHEET_MAX_COLUMNS + 1)}\n1`);
  });
});

describe("columnOf", () => {
  test("the two columns GYM reads are found whatever their case, the rest has no meaning", () => {
    const sheet = parseRunSheet("Episode,Prompt,arm\n1,pick,left", "s.csv", null);
    expect(columnOf(sheet, "episode")).toBe("Episode");
    expect(columnOf(sheet, "prompt")).toBe("Prompt");
    expect(columnOf(parseRunSheet("a\n1", "s.csv", null), "prompt")).toBeNull();
  });
});

describe("planStepsFromRunSheet", () => {
  const sheet = parseRunSheet(EXAMPLE, "Pick_from_Shelf_v4.csv", "layout");

  test("a group of rows is a plan step, a row is one episode of it with its columns as labelled values", () => {
    const steps = planStepsFromRunSheet(sheet, null);
    expect(steps.map((s) => [s.title, s.episodes])).toEqual([["layout 1", 2], ["layout 2", 1]]);
    expect(steps[0]!.instructions).toBe("");
    const first = steps[0]!.variations[0]!;
    expect(first.label).toBe("1 · pick the brown tube gel from the shelf");
    expect(first.episodes).toBe(1);
    // every other column in file order: not the group, not the episode, not the prompt
    expect(first.fields).toEqual([
      { name: "background", value: "1" },
      { name: "target_code", value: "T" },
      { name: "target", value: "brown tube gel" },
      { name: "position", value: "1F" },
      { name: "arm", value: "left" },
      { name: "empty_fronts", value: "4F" },
      { name: "recorded_prompt", value: "pick the object from the shelf" },
    ]);
    expect(steps[1]!.variations[0]!.fields!.find((f) => f.name === "empty_fronts")!.value).toBe("1F,2F");
  });

  test("only the rows asked for, by their place in the sheet", () => {
    const steps = planStepsFromRunSheet(sheet, [2]);
    expect(steps).toHaveLength(1);
    expect(steps[0]!.variations.map((x) => x.label)).toEqual(["2 · pick the pink shower gel from the shelf"]);
    expect(planStepsFromRunSheet(sheet, [1, 3]).map((s) => s.title)).toEqual(["layout 1", "layout 2"]);
  });

  test("without a group column the sheet is one step, named after the file", () => {
    const steps = planStepsFromRunSheet({ ...sheet, groupBy: null }, null);
    expect(steps.map((s) => [s.title, s.episodes])).toEqual([["Pick_from_Shelf_v4.csv", 3]]);
    // the column that would have grouped is now a value like any other
    expect(steps[0]!.variations[0]!.fields![0]).toEqual({ name: "layout", value: "1" });
  });

  test("a sheet without an episode or a prompt column counts its rows, empty cells are left out", () => {
    const plain = parseRunSheet("object,note\ncup,\nplate,fragile", "s.csv", null);
    const [step] = planStepsFromRunSheet(plain, null);
    expect(step!.variations.map((x) => x.label)).toEqual(["1", "2"]);
    expect(step!.variations[0]!.fields).toEqual([{ name: "object", value: "cup" }]);
    const prompted = parseRunSheet("prompt\npick the cup", "s.csv", null);
    expect(planStepsFromRunSheet(prompted, null)[0]!.variations[0]!.label).toBe("1 · pick the cup");
  });

  test("a group that comes back later is a step of its own: the order of the sheet is the order of the day", () => {
    const back = parseRunSheet("episode,layout\n1,A\n2,B\n3,A", "s.csv", "layout");
    expect(planStepsFromRunSheet(back, null).map((s) => s.title)).toEqual(["layout A", "layout B", "layout A"]);
  });

  test("a label fits the plan: cut at 300 characters, values too", () => {
    const long = parseRunSheet(`episode,prompt,note\n1,${"p".repeat(400)},${"n".repeat(400)}`, "s.csv", null);
    const variation = planStepsFromRunSheet(long, null)[0]!.variations[0]!;
    expect(variation.label).toHaveLength(300);
    expect(variation.fields![0]!.value).toHaveLength(300);
  });
});
