/**
 * Cells: the physical training cells of the gym. A small pick list per
 * organisation; day protocols reference a cell by id.
 *
 * A cell says which robot stands in it (`robotId`), which is the one place
 * the robot's whereabouts are kept (lib/gym/robots.ts). Three states:
 *
 *   robotId set        that robot is in the cell
 *   noRobot            said on purpose: no robot yet
 *   neither            undefined: nobody said
 *
 * Putting a robot into a cell takes it out of the cell it was in; both are
 * written to the robot's history.
 */
import { and, asc, eq, ne } from "drizzle-orm";
import * as v from "valibot";
import { getDb } from "@framework/lib/db/db-connection";
import { cells, dayProtocols, type CellSelect } from "../../db/schema";
import { recordAudit, type Actor } from "./audit";
import { ConflictError, InvalidInputError, NotFoundError } from "./errors";
import { getRobotRow } from "./robots";

export const cellInputSchema = v.object({
  name: v.pipe(v.string(), v.trim(), v.minLength(1, "Name is required"), v.maxLength(120)),
  location: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(200)), ""),
  robotId: v.optional(v.nullable(v.pipe(v.string(), v.uuid())), null),
  noRobot: v.optional(v.boolean(), false),
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

export async function createCell(tenantId: string, actor: Actor, input: unknown): Promise<CellSelect> {
  const data = v.parse(cellInputSchema, input);
  const existing = await getDb()
    .select({ id: cells.id })
    .from(cells)
    .where(and(eq(cells.tenantId, tenantId), eq(cells.name, data.name)))
    .limit(1);
  if (existing[0]) throw new InvalidInputError(`A cell named "${data.name}" already exists`);
  const { robotId, ...rest } = data;
  if (robotId) await getRobotRow(tenantId, robotId);
  const [row] = await getDb().insert(cells).values({ tenantId, ...rest, noRobot: !robotId && rest.noRobot }).returning();
  if (robotId) return placeRobot(tenantId, actor, row!, robotId);
  return row!;
}

export async function updateCell(tenantId: string, actor: Actor, id: string, input: unknown): Promise<CellSelect> {
  const { robotId, ...data } = v.parse(v.partial(cellInputSchema), input);
  const before = await getCell(tenantId, id);
  // a robot in the cell and "no robot yet" exclude each other
  const nextRobotId = robotId !== undefined ? robotId : data.noRobot ? null : before.robotId;
  const moving = nextRobotId !== before.robotId;
  if (moving && nextRobotId) await getRobotRow(tenantId, nextRobotId);
  const [row] = await getDb()
    .update(cells)
    .set({
      ...data,
      robotId: moving ? null : before.robotId,
      noRobot: nextRobotId ? false : (data.noRobot ?? before.noRobot),
      updatedAt: new Date().toISOString(),
    })
    .where(and(eq(cells.id, id), eq(cells.tenantId, tenantId)))
    .returning();
  if (moving && before.robotId) {
    await recordAudit(tenantId, { robotId: before.robotId }, actor, "robot.unassigned", { cellId: id, cellName: row!.name });
  }
  if (moving && nextRobotId) return placeRobot(tenantId, actor, row!, nextRobotId);
  return row!;
}

/** Put a robot into a cell, taking it out of the cell it stood in. The robot is checked by the caller. */
async function placeRobot(tenantId: string, actor: Actor, cell: CellSelect, robotId: string): Promise<CellSelect> {
  const [from] = await getDb()
    .update(cells)
    .set({ robotId: null, updatedAt: new Date().toISOString() })
    .where(and(eq(cells.tenantId, tenantId), eq(cells.robotId, robotId), ne(cells.id, cell.id)))
    .returning({ id: cells.id, name: cells.name });
  const [row] = await getDb()
    .update(cells)
    .set({ robotId, noRobot: false, updatedAt: new Date().toISOString() })
    .where(eq(cells.id, cell.id))
    .returning();
  await recordAudit(tenantId, { robotId }, actor, "robot.assigned", {
    cellId: cell.id,
    cellName: cell.name,
    ...(from ? { fromCellId: from.id, fromCellName: from.name } : {}),
  });
  return row!;
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
