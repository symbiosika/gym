/**
 * Invitation codes: who may register on this instance.
 *
 * The framework decides at registration time: as soon as at least one active
 * row exists in `invitation_codes`, a new e-mail address needs a valid code
 * (or a pending organisation invitation) to get an account. A code that
 * carries a tenant id puts the new user straight into that organisation.
 *
 * The framework ships the check but no management, so the gym owns it here:
 * owners and admins of an organisation create, deactivate and delete the
 * codes of their organisation. Expiry is enforced by `deactivateExpiredCodes`
 * (cron, once a minute), because the framework only looks at `isActive`.
 */
import { and, desc, eq, isNotNull, lt } from "drizzle-orm";
import { customAlphabet } from "nanoid";
import { getDb } from "@framework/lib/db/db-connection";
import { invitationCodes, type InvitationCodesSelect } from "@framework/lib/db/schema/users";
import { checkIfInvitationCodeIsNeededToRegister } from "@framework/lib/usermanagement/invitations";

/** Readable, unambiguous alphabet (no 0/O, 1/I/L). */
const segment = customAlphabet("ABCDEFGHJKMNPQRSTUVWXYZ23456789", 4);

export const generateCode = (): string => `GYM-${segment()}-${segment()}`;

export interface InvitationCodeView extends InvitationCodesSelect {
  /** false when expired (even if isActive is still true until the cron ran) */
  usable: boolean;
}

const toView = (row: InvitationCodesSelect): InvitationCodeView => ({
  ...row,
  usable: row.isActive && (!row.expiresAt || new Date(row.expiresAt).getTime() > Date.now()),
});

export async function listInvitationCodes(tenantId: string): Promise<InvitationCodeView[]> {
  const rows = await getDb()
    .select()
    .from(invitationCodes)
    .where(eq(invitationCodes.tenantId, tenantId))
    .orderBy(desc(invitationCodes.createdAt));
  return rows.map(toView);
}

/** Whether registration on this instance currently requires a code (any organisation). */
export async function registrationStatus(tenantId: string) {
  const codes = await listInvitationCodes(tenantId);
  return {
    protected: await checkIfInvitationCodeIsNeededToRegister(),
    activeCodes: codes.filter((c) => c.usable).length,
  };
}

export async function createInvitationCode(
  tenantId: string,
  input: { expiresAt?: string | null } = {},
): Promise<InvitationCodeView> {
  // retry on the (very unlikely) collision of the unique code
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const [row] = await getDb()
        .insert(invitationCodes)
        .values({ code: generateCode(), tenantId, isActive: true, expiresAt: input.expiresAt ?? null })
        .returning();
      return toView(row!);
    } catch (error) {
      if (attempt === 4) throw error;
    }
  }
  throw new Error("could not generate a unique code");
}

export async function setInvitationCodeActive(
  tenantId: string,
  id: string,
  isActive: boolean,
): Promise<InvitationCodeView | null> {
  const [row] = await getDb()
    .update(invitationCodes)
    .set({ isActive })
    .where(and(eq(invitationCodes.id, id), eq(invitationCodes.tenantId, tenantId)))
    .returning();
  return row ? toView(row) : null;
}

export async function deleteInvitationCode(tenantId: string, id: string): Promise<boolean> {
  const rows = await getDb()
    .delete(invitationCodes)
    .where(and(eq(invitationCodes.id, id), eq(invitationCodes.tenantId, tenantId)))
    .returning({ id: invitationCodes.id });
  return rows.length > 0;
}

/** Cron: switch off codes whose expiry has passed. Returns how many were switched off. */
export async function deactivateExpiredCodes(): Promise<number> {
  const rows = await getDb()
    .update(invitationCodes)
    .set({ isActive: false })
    .where(
      and(
        eq(invitationCodes.isActive, true),
        isNotNull(invitationCodes.expiresAt),
        lt(invitationCodes.expiresAt, new Date().toISOString()),
      ),
    )
    .returning({ id: invitationCodes.id });
  return rows.length;
}
