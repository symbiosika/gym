/**
 * Robots: the robots of the gym and what they can do.
 *
 * A robot has a technical name (the canonical one, model and number) and a
 * personal name (what the people of the gym call it), a status, a photo, the
 * platform reference and the capability sections every robot has, always the
 * same: sensors, actuators, locomotion, compute, communication and system (the
 * software). Each section is a list of components with a quantity and a status.
 *
 * Where a robot is comes from the cell that points at it (`cells.robot_id`,
 * set in the settings, lib/gym/cells.ts), never from the robot itself. A robot
 * is in one cell at most; the move is written to the robot's audit log, which
 * is its history.
 */
import { and, asc, eq } from "drizzle-orm";
import * as v from "valibot";
import { getDb } from "@framework/lib/db/db-connection";
import {
  CAPABILITY_SECTIONS,
  COMPONENT_STATUSES,
  EMPTY_ROBOT_CAPABILITIES,
  EMPTY_ROBOT_PLATFORM,
  ROBOT_STATUSES,
  cells,
  robots,
  type AuditLogSelect,
  type ComponentStatus,
  type RobotCapabilities,
  type RobotComponent,
  type RobotPlatform,
  type RobotSelect,
  type RobotStatus,
} from "../../db/schema";
import { putFile, readFile, removeFile } from "../storage";
import { listAudit, recordAudit, type Actor } from "./audit";
import { IMAGE_TYPES, MAX_IMAGE_BYTES } from "./blocks";
import { ROBOT_IMAGE_BUCKET } from "./buckets";
import { InvalidInputError, NotFoundError } from "./errors";

const text = (max: number) => v.optional(v.pipe(v.string(), v.trim(), v.maxLength(max)), "");

const componentSchema = v.object({
  id: v.optional(v.pipe(v.string(), v.maxLength(64))),
  name: v.pipe(v.string(), v.trim(), v.minLength(1, "A component needs a name"), v.maxLength(200)),
  type: text(120),
  quantity: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(10000)), 1),
  status: v.optional(v.picklist(COMPONENT_STATUSES), "unknown"),
  note: text(2000),
});

const sectionSchema = v.pipe(v.array(componentSchema), v.maxLength(200));

/** One key per entry of CAPABILITY_SECTIONS. */
const capabilitiesSchema = v.partial(
  v.object({
    sensors: sectionSchema,
    actuators: sectionSchema,
    locomotion: sectionSchema,
    compute: sectionSchema,
    communication: sectionSchema,
    system: sectionSchema,
  }),
);

const platformSchema = v.partial(
  v.object({ manufacturer: text(200), model: text(200), serialNumber: text(200), productVersion: text(200) }),
);

export const robotInputSchema = v.object({
  technicalName: v.pipe(v.string(), v.trim(), v.minLength(1, "The technical name is required"), v.maxLength(200)),
  personalName: text(120),
  status: v.optional(v.picklist(ROBOT_STATUSES), "in_service"),
  notes: text(8000),
  platform: v.optional(platformSchema),
  capabilities: v.optional(capabilitiesSchema),
});

/** The cell a robot is in, as the robot list and the robot show it. */
export interface RobotCell {
  id: string;
  name: string;
  location: string;
  active: boolean;
}

/** The components of a robot counted by status, over all sections: the list's health at a glance. */
export type RobotHealth = Record<ComponentStatus, number>;

export interface RobotView {
  id: string;
  technicalName: string;
  personalName: string;
  status: RobotStatus;
  notes: string;
  hasImage: boolean;
  platform: RobotPlatform;
  capabilities: RobotCapabilities;
  cell: RobotCell | null;
  health: RobotHealth;
  createdAt: string;
  updatedAt: string;
}

/** Every section present, every component with an id, so the client edits one shape. */
function normaliseCapabilities(input: v.InferOutput<typeof capabilitiesSchema> | undefined, base: RobotCapabilities): RobotCapabilities {
  const out = { ...EMPTY_ROBOT_CAPABILITIES, ...base };
  for (const section of CAPABILITY_SECTIONS) {
    const items = input?.[section];
    if (!items) continue;
    out[section] = items.map((c): RobotComponent => ({ ...c, id: c.id || crypto.randomUUID() }));
  }
  return out;
}

export function robotHealth(capabilities: RobotCapabilities): RobotHealth {
  const health: RobotHealth = { ok: 0, degraded: 0, faulty: 0, unknown: 0 };
  for (const section of CAPABILITY_SECTIONS) for (const c of capabilities[section] ?? []) health[c.status] += 1;
  return health;
}

function toRobotView(row: RobotSelect, cell: RobotCell | null): RobotView {
  const capabilities = normaliseCapabilities(undefined, row.capabilities);
  return {
    id: row.id,
    technicalName: row.technicalName,
    personalName: row.personalName,
    status: row.status,
    notes: row.notes,
    hasImage: !!row.imageRef,
    platform: { ...EMPTY_ROBOT_PLATFORM, ...row.platform },
    capabilities,
    cell,
    health: robotHealth(capabilities),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

const cellColumns = { id: cells.id, name: cells.name, location: cells.location, active: cells.active };

/** The robots of an organisation with the cell each is in, by personal name, then technical name. */
export async function listRobots(tenantId: string): Promise<RobotView[]> {
  const rows = await getDb()
    .select({ robot: robots, cell: cellColumns })
    .from(robots)
    .leftJoin(cells, and(eq(cells.robotId, robots.id), eq(cells.tenantId, tenantId)))
    .where(eq(robots.tenantId, tenantId))
    .orderBy(asc(robots.technicalName));
  const views = rows.map((r) => toRobotView(r.robot, r.cell?.id ? r.cell : null));
  const label = (r: RobotView) => (r.personalName || r.technicalName).toLowerCase();
  return views.sort((a, b) => label(a).localeCompare(label(b)));
}

export async function getRobotRow(tenantId: string, id: string): Promise<RobotSelect> {
  const rows = await getDb()
    .select()
    .from(robots)
    .where(and(eq(robots.id, id), eq(robots.tenantId, tenantId)))
    .limit(1);
  if (!rows[0]) throw new NotFoundError("Robot");
  return rows[0];
}

export async function getRobot(tenantId: string, id: string): Promise<RobotView> {
  const row = await getRobotRow(tenantId, id);
  const cell = await getDb()
    .select(cellColumns)
    .from(cells)
    .where(and(eq(cells.robotId, id), eq(cells.tenantId, tenantId)))
    .limit(1);
  return toRobotView(row, cell[0] ?? null);
}

async function assertTechnicalNameFree(tenantId: string, name: string, exceptId?: string) {
  const existing = await getDb()
    .select({ id: robots.id })
    .from(robots)
    .where(and(eq(robots.tenantId, tenantId), eq(robots.technicalName, name)))
    .limit(1);
  if (existing[0] && existing[0].id !== exceptId) throw new InvalidInputError(`A robot named "${name}" already exists`);
}

export async function createRobot(tenantId: string, actor: Actor, input: unknown): Promise<RobotView> {
  const data = v.parse(robotInputSchema, input);
  await assertTechnicalNameFree(tenantId, data.technicalName);
  const [row] = await getDb()
    .insert(robots)
    .values({
      tenantId,
      technicalName: data.technicalName,
      personalName: data.personalName,
      status: data.status,
      notes: data.notes,
      platform: { ...EMPTY_ROBOT_PLATFORM, ...data.platform },
      capabilities: normaliseCapabilities(data.capabilities, EMPTY_ROBOT_CAPABILITIES),
    })
    .returning();
  await recordAudit(tenantId, { robotId: row!.id }, actor, "robot.created", { technicalName: row!.technicalName });
  return toRobotView(row!, null);
}

/**
 * Change a robot. A section that is sent replaces the section as a whole; one
 * that is left out stays as it is, so the modal can save one section at a time.
 */
export async function updateRobot(tenantId: string, actor: Actor, id: string, input: unknown): Promise<RobotView> {
  const data = v.parse(v.partial(robotInputSchema), input);
  const row = await getRobotRow(tenantId, id);
  if (data.technicalName !== undefined) await assertTechnicalNameFree(tenantId, data.technicalName, id);
  const [updated] = await getDb()
    .update(robots)
    .set({
      ...(data.technicalName !== undefined ? { technicalName: data.technicalName } : {}),
      ...(data.personalName !== undefined ? { personalName: data.personalName } : {}),
      ...(data.status !== undefined ? { status: data.status } : {}),
      ...(data.notes !== undefined ? { notes: data.notes } : {}),
      ...(data.platform !== undefined ? { platform: { ...EMPTY_ROBOT_PLATFORM, ...row.platform, ...data.platform } } : {}),
      ...(data.capabilities !== undefined ? { capabilities: normaliseCapabilities(data.capabilities, row.capabilities) } : {}),
      updatedAt: new Date().toISOString(),
    })
    .where(and(eq(robots.id, id), eq(robots.tenantId, tenantId)))
    .returning();
  const changed = Object.keys(data);
  const details: Record<string, unknown> = { changed };
  if (data.status !== undefined && data.status !== row.status) details.status = { from: row.status, to: data.status };
  await recordAudit(tenantId, { robotId: id }, actor, "robot.updated", details);
  return getRobot(tenantId, updated!.id);
}

/**
 * Delete a robot. Its cell is left with an undefined robot, not with "no robot
 * yet": that the robot is gone says nothing about what stands in the cell. A
 * robot that is out for good is better retired, which keeps its history.
 */
export async function deleteRobot(tenantId: string, actor: Actor, id: string): Promise<void> {
  const row = await getRobotRow(tenantId, id);
  await recordAudit(tenantId, { robotId: id }, actor, "robot.deleted", { technicalName: row.technicalName });
  await getDb()
    .delete(robots)
    .where(and(eq(robots.id, id), eq(robots.tenantId, tenantId)));
  if (row.imageRef) await removeFile(tenantId, ROBOT_IMAGE_BUCKET, row.imageRef).catch(() => undefined);
}

/** The robot's history: created, changed, moved between cells. Newest first. */
export async function listRobotAudit(tenantId: string, id: string): Promise<AuditLogSelect[]> {
  await getRobotRow(tenantId, id);
  return listAudit(tenantId, { robotId: id }, 200);
}

// ---------------------------------------------------------------------------
// Photo
// ---------------------------------------------------------------------------

export async function setRobotImage(tenantId: string, actor: Actor, id: string, file: File): Promise<RobotView> {
  if (!IMAGE_TYPES.has(file.type)) throw new InvalidInputError("Only JPEG, PNG, WebP or HEIC images are accepted");
  if (file.size > MAX_IMAGE_BYTES) throw new InvalidInputError("The image is larger than 15 MB");
  const row = await getRobotRow(tenantId, id);
  const saved = await putFile(tenantId, ROBOT_IMAGE_BUCKET, file);
  if (row.imageRef) await removeFile(tenantId, ROBOT_IMAGE_BUCKET, row.imageRef).catch(() => undefined);
  await getDb()
    .update(robots)
    .set({ imageRef: saved.ref, updatedAt: new Date().toISOString() })
    .where(eq(robots.id, id));
  await recordAudit(tenantId, { robotId: id }, actor, "robot.image", { bytes: file.size, type: file.type });
  return getRobot(tenantId, id);
}

export async function removeRobotImage(tenantId: string, actor: Actor, id: string): Promise<RobotView> {
  const row = await getRobotRow(tenantId, id);
  if (row.imageRef) await removeFile(tenantId, ROBOT_IMAGE_BUCKET, row.imageRef).catch(() => undefined);
  await getDb()
    .update(robots)
    .set({ imageRef: null, updatedAt: new Date().toISOString() })
    .where(eq(robots.id, id));
  await recordAudit(tenantId, { robotId: id }, actor, "robot.image.removed", {});
  return getRobot(tenantId, id);
}

export async function getRobotImage(tenantId: string, id: string): Promise<File | null> {
  const row = await getRobotRow(tenantId, id);
  if (!row.imageRef) return null;
  return readFile(tenantId, ROBOT_IMAGE_BUCKET, row.imageRef);
}
