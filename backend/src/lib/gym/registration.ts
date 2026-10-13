/**
 * Post-register hook: a person who signs up with an invitation code of an
 * organisation becomes a member of that organisation.
 *
 * The framework validates the code on the magic-link path but only assigns
 * the tenant on the password-register path. This hook closes the gap for the
 * gym, where every login is a magic link (or passkey). Runs after the user
 * row exists; a user who already is a member is left alone.
 */
import { and, eq } from "drizzle-orm";
import { getDb } from "@framework/lib/db/db-connection";
import { invitationCodes, tenantMembers, users } from "@framework/lib/db/schema/users";
import { addTenantMember } from "@framework/lib/usermanagement/tenants";
import log from "@framework/lib/log";

export async function joinOrganisationFromInvitationCode(
  userId: string,
  _email: string,
  meta?: { invitationCode?: string },
): Promise<{ joined: boolean; tenantId: string | null }> {
  const code = meta?.invitationCode?.trim();
  if (!code) return { joined: false, tenantId: null };

  const rows = await getDb()
    .select({ tenantId: invitationCodes.tenantId })
    .from(invitationCodes)
    .where(and(eq(invitationCodes.code, code), eq(invitationCodes.isActive, true)))
    .limit(1);
  const tenantId = rows[0]?.tenantId ?? null;
  if (!tenantId) return { joined: false, tenantId: null };

  const existing = await getDb()
    .select({ userId: tenantMembers.userId })
    .from(tenantMembers)
    .where(and(eq(tenantMembers.tenantId, tenantId), eq(tenantMembers.userId, userId)))
    .limit(1);
  if (!existing.length) {
    await addTenantMember(tenantId, userId, "member");
    log.info(`gym: user ${userId} joined organisation ${tenantId} via invitation code`);
  }
  await getDb().update(users).set({ lastTenantId: tenantId }).where(eq(users.id, userId));
  return { joined: !existing.length, tenantId };
}
