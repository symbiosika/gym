/**
 * The strategy of a skill: how it is to be recorded, as its people wrote it
 * down. A description in plain text, pictures and PDFs, and the run sheet
 * (lib/gym/run-sheet.ts). It lives on the skill as one JSON document; the
 * bytes of the files go through lib/storage like every other byte.
 *
 * Nothing here is binding. The strategy is there to be read, and its run
 * sheet may be taken over by a block as its recording plan (lib/gym/blocks.ts,
 * `planFromRunSheet`); a block that takes nothing over works as it always did.
 */
import * as v from "valibot";
import { and, eq } from "drizzle-orm";
import { getDb } from "@framework/lib/db/db-connection";
import { skills, type SkillStrategy, type StrategyFile } from "../../db/schema";
import { putFile, readFile, removeFile } from "../storage";
import { recordAudit, type Actor } from "./audit";
import { STRATEGY_BUCKET } from "./buckets";
import { InvalidInputError, NotFoundError } from "./errors";
import { parseRunSheet } from "./run-sheet";
import { getSkillRow } from "./skills";

export const STRATEGY_FILE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "application/pdf"]);
export const MAX_STRATEGY_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_STRATEGY_FILES = 20;
export const MAX_STRATEGY_TEXT = 20000;
/** the CSV as it is sent, before it is read into rows */
export const MAX_RUN_SHEET_BYTES = 2 * 1024 * 1024;

const emptyStrategy = (): SkillStrategy => ({ text: "", files: [], runSheet: null, updatedAt: new Date().toISOString() });

/** The strategy of a skill; an empty one while nobody has written any. */
export async function getStrategy(tenantId: string, skillId: string): Promise<SkillStrategy> {
  const skill = await getSkillRow(tenantId, skillId);
  return skill.strategy ?? emptyStrategy();
}

/** Change the stored strategy in one step and hand back what is stored now. */
async function change(tenantId: string, skillId: string, patch: (current: SkillStrategy) => SkillStrategy): Promise<SkillStrategy> {
  const next = { ...patch(await getStrategy(tenantId, skillId)), updatedAt: new Date().toISOString() };
  await getDb()
    .update(skills)
    .set({ strategy: next })
    .where(and(eq(skills.id, skillId), eq(skills.tenantId, tenantId)));
  return next;
}

const textSchema = v.object({ text: v.pipe(v.string(), v.maxLength(MAX_STRATEGY_TEXT)) });

export async function updateStrategyText(tenantId: string, actor: Actor, skillId: string, input: unknown): Promise<SkillStrategy> {
  const { text } = v.parse(textSchema, input);
  const next = await change(tenantId, skillId, (s) => ({ ...s, text }));
  await recordAudit(tenantId, { skillId }, actor, "strategy.updated", { characters: text.length });
  return next;
}

export async function addStrategyFile(tenantId: string, actor: Actor, skillId: string, file: File): Promise<SkillStrategy> {
  if (!STRATEGY_FILE_TYPES.has(file.type)) throw new InvalidInputError("Only PNG, JPEG or WebP images and PDFs are accepted");
  if (file.size > MAX_STRATEGY_FILE_BYTES) throw new InvalidInputError("The file is larger than 20 MB");
  const current = await getStrategy(tenantId, skillId);
  if (current.files.length >= MAX_STRATEGY_FILES) throw new InvalidInputError(`A strategy holds at most ${MAX_STRATEGY_FILES} files`);
  const saved = await putFile(tenantId, STRATEGY_BUCKET, file);
  const entry: StrategyFile = {
    id: crypto.randomUUID(),
    ref: saved.ref,
    name: (file.name || "file").slice(0, 300),
    mime: file.type,
    size: file.size,
    createdAt: new Date().toISOString(),
  };
  const next = await change(tenantId, skillId, (s) => ({ ...s, files: [...s.files, entry] }));
  await recordAudit(tenantId, { skillId }, actor, "strategy.file_added", { fileId: entry.id, name: entry.name, type: entry.mime, bytes: entry.size });
  return next;
}

/** The bytes of one file of the strategy, with what is known about it. */
export async function getStrategyFile(tenantId: string, skillId: string, fileId: string): Promise<{ file: File; meta: StrategyFile }> {
  const meta = (await getStrategy(tenantId, skillId)).files.find((f) => f.id === fileId);
  if (!meta) throw new NotFoundError("Strategy file");
  return { file: await readFile(tenantId, STRATEGY_BUCKET, meta.ref), meta };
}

export async function removeStrategyFile(tenantId: string, actor: Actor, skillId: string, fileId: string): Promise<SkillStrategy> {
  const meta = (await getStrategy(tenantId, skillId)).files.find((f) => f.id === fileId);
  if (!meta) throw new NotFoundError("Strategy file");
  const next = await change(tenantId, skillId, (s) => ({ ...s, files: s.files.filter((f) => f.id !== fileId) }));
  await removeFile(tenantId, STRATEGY_BUCKET, meta.ref).catch(() => undefined);
  await recordAudit(tenantId, { skillId }, actor, "strategy.file_removed", { fileId, name: meta.name });
  return next;
}

const runSheetSchema = v.object({
  fileName: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(300)),
  csv: v.pipe(v.string(), v.maxLength(MAX_RUN_SHEET_BYTES, "The run sheet is larger than 2 MB")),
  groupBy: v.optional(v.nullable(v.pipe(v.string(), v.maxLength(300))), null),
});

/** Read a CSV into the skill's run sheet, replacing the one before. Only the rows are stored, never the file. */
export async function setRunSheet(tenantId: string, actor: Actor, skillId: string, input: unknown): Promise<SkillStrategy> {
  const data = v.parse(runSheetSchema, input);
  await getSkillRow(tenantId, skillId);
  const runSheet = parseRunSheet(data.csv, data.fileName, data.groupBy || null);
  const next = await change(tenantId, skillId, (s) => ({ ...s, runSheet }));
  await recordAudit(tenantId, { skillId }, actor, "strategy.run_sheet_imported", {
    fileName: runSheet.fileName,
    rows: runSheet.rows.length,
    columns: runSheet.columns.length,
    groupBy: runSheet.groupBy,
  });
  return next;
}

export async function removeRunSheet(tenantId: string, actor: Actor, skillId: string): Promise<SkillStrategy> {
  const next = await change(tenantId, skillId, (s) => ({ ...s, runSheet: null }));
  await recordAudit(tenantId, { skillId }, actor, "strategy.run_sheet_removed", {});
  return next;
}
