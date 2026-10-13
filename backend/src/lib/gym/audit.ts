/**
 * Audit log.
 *
 * Every relevant action is recorded with the acting user and a timestamp:
 * skill created and archived, block started and closed, scene brief, plan,
 * recording, dataset upload, analysis, selection, export. A row points at the
 * skill, the day protocol and the block it concerns, whichever apply, so the
 * log can be read per skill (the product) and per day protocol (the cell's
 * day). Append-only.
 */
import { and, desc, eq } from "drizzle-orm";
import { getDb } from "@framework/lib/db/db-connection";
import { users } from "@framework/lib/db/schema/users";
import { auditLog, type AuditLogSelect } from "../../db/schema";

/** Who performs an action. `null` stands for an unauthenticated mobile view. */
export interface Actor {
  userId: string | null;
  userName: string;
}

export const SYSTEM_ACTOR: Actor = { userId: null, userName: "system" };

/** What an audit row is about. Any of the three may be missing. */
export interface AuditRefs {
  skillId?: string | null;
  dayProtocolId?: string | null;
  blockId?: string | null;
}

/** Display name of a user: first name and surname, else the e-mail. */
export async function actorFromUser(userId: string): Promise<Actor> {
  const rows = await getDb()
    .select({ email: users.email, firstname: users.firstname, surname: users.surname })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const u = rows[0];
  if (!u) return { userId, userName: "" };
  const name = [u.firstname, u.surname].filter(Boolean).join(" ").trim();
  return { userId, userName: name || u.email };
}

export async function recordAudit(
  tenantId: string,
  refs: AuditRefs,
  actor: Actor,
  action: string,
  details: Record<string, unknown> = {},
): Promise<AuditLogSelect> {
  const [row] = await getDb()
    .insert(auditLog)
    .values({
      tenantId,
      skillId: refs.skillId ?? null,
      dayProtocolId: refs.dayProtocolId ?? null,
      blockId: refs.blockId ?? null,
      userId: actor.userId,
      userName: actor.userName,
      action,
      details,
    })
    .returning();
  return row!;
}

/** The log of a skill or of a day protocol, newest first. */
export async function listAudit(tenantId: string, by: { skillId?: string; dayProtocolId?: string }, limit = 500): Promise<AuditLogSelect[]> {
  const conditions = [eq(auditLog.tenantId, tenantId)];
  if (by.skillId) conditions.push(eq(auditLog.skillId, by.skillId));
  if (by.dayProtocolId) conditions.push(eq(auditLog.dayProtocolId, by.dayProtocolId));
  return getDb()
    .select()
    .from(auditLog)
    .where(and(...conditions))
    .orderBy(desc(auditLog.createdAt))
    .limit(limit);
}
