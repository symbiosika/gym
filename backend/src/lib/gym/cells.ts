/**
 * Cells: the physical training cells of the gym. A small pick list per
 * organisation; day protocols reference a cell by id.
 */
import { and, asc, eq } from "drizzle-orm";
import * as v from "valibot";
import { getDb } from "@framework/lib/db/db-connection";
import { cells, dayProtocols, type CellSelect } from "../../db/schema";
import { ConflictError, InvalidInputError, NotFoundError } from "./errors";

export const cellInputSchema = v.object({
  name: v.pipe(v.string(), v.trim(), v.minLength(1, "Name is required"), v.maxLength(120)),
  location: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(200)), ""),
  robot: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(200)), ""),
  active: v.optional(v.boolean(), true),
  sortOrder: v.optional(v.number(), 0),
});
export type CellInput = v.InferOutput<typeof cellInputSchema>;

export async function listCells(tenantId: string, includeInactive = true): Promise<CellSelect[]> {
  const where = includeInactive
    ? eq(cells.tenantId, tenantId)
    : and(eq(cells.tenantId, tenantId), eq(cells.active, true));
  return getDb().select().from(cells).where(where).orderBy(asc(cells.sortOrder), asc(cells.name));
}

export async function getCell(tenantId: string, id: string): Promise<CellSelect> {
  const rows = await getDb()
    .select()
    .from(cells)
    .where(and(eq(cells.id, id), eq(cells.tenantId, tenantId)))
    .limit(1);
  if (!rows[0]) throw new NotFoundError("Cell");
  return rows[0];
}

export async function createCell(tenantId: string, input: unknown): Promise<CellSelect> {
  const data = v.parse(cellInputSchema, input);
  const existing = await getDb()
    .select({ id: cells.id })
    .from(cells)
    .where(and(eq(cells.tenantId, tenantId), eq(cells.name, data.name)))
    .limit(1);
  if (existing[0]) throw new InvalidInputError(`A cell named "${data.name}" already exists`);
  const [row] = await getDb().insert(cells).values({ tenantId, ...data }).returning();
  return row!;
}

export async function updateCell(tenantId: string, id: string, input: unknown): Promise<CellSelect> {
  const data = v.parse(v.partial(cellInputSchema), input);
  const [row] = await getDb()
    .update(cells)
    .set({ ...data, updatedAt: new Date().toISOString() })
    .where(and(eq(cells.id, id), eq(cells.tenantId, tenantId)))
    .returning();
  if (!row) throw new NotFoundError("Cell");
  return row;
}

/** A cell with day protocols cannot be deleted, only deactivated. */
export async function deleteCell(tenantId: string, id: string): Promise<void> {
  const used = await getDb().select({ id: dayProtocols.id }).from(dayProtocols).where(eq(dayProtocols.cellId, id)).limit(1);
  if (used[0]) throw new ConflictError("The cell has day protocols; deactivate it instead of deleting it");
  const deleted = await getDb()
    .delete(cells)
    .where(and(eq(cells.id, id), eq(cells.tenantId, tenantId)))
    .returning({ id: cells.id });
  if (!deleted.length) throw new NotFoundError("Cell");
}
