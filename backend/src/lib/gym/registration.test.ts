import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { initTests, TEST_ORGANISATION_1, TEST_ORG2_USER_1 } from "@framework/test/init.test";
import { getDb } from "@framework/lib/db/db-connection";
import { invitationCodes, tenantMembers, users } from "@framework/lib/db/schema/users";
import { createInvitationCode } from "./invitation-codes";
import { joinOrganisationFromInvitationCode } from "./registration";

const T = TEST_ORGANISATION_1.id;
// a user of another organisation stands in for the freshly registered person
const U = TEST_ORG2_USER_1.id;

const cleanup = async () => {
  await getDb().delete(tenantMembers).where(and(eq(tenantMembers.tenantId, T), eq(tenantMembers.userId, U)));
  await getDb().delete(invitationCodes).where(eq(invitationCodes.tenantId, T));
};

describe("registration with invitation code", () => {
  beforeAll(async () => {
    await initTests();
    await cleanup();
  });
  afterAll(async () => {
    // awaited on purpose: an unawaited delete keeps running into the next test
    // file's initTests(), which recreates the test tenants. With one pooled
    // connection the interleaved queries break the wire protocol.
    await cleanup().catch((e) => console.warn("afterAll cleanup failed:", e));
  });

  test("no code → nothing happens", async () => {
    expect(await joinOrganisationFromInvitationCode(U, "x@y.z", {})).toEqual({ joined: false, tenantId: null });
    expect(await joinOrganisationFromInvitationCode(U, "x@y.z", { invitationCode: "GYM-NOPE-NOPE" })).toEqual({ joined: false, tenantId: null });
  });

  test("a code of the organisation makes the user a member, idempotent", async () => {
    const code = await createInvitationCode(T);
    const first = await joinOrganisationFromInvitationCode(U, TEST_ORG2_USER_1.email, { invitationCode: code.code });
    expect(first).toEqual({ joined: true, tenantId: T });
    const rows = await getDb().select().from(tenantMembers).where(and(eq(tenantMembers.tenantId, T), eq(tenantMembers.userId, U)));
    expect(rows.length).toBe(1);
    expect(rows[0]!.role).toBe("member");
    const user = await getDb().select({ lastTenantId: users.lastTenantId }).from(users).where(eq(users.id, U));
    expect(user[0]!.lastTenantId).toBe(T);
    const second = await joinOrganisationFromInvitationCode(U, TEST_ORG2_USER_1.email, { invitationCode: code.code });
    expect(second.joined).toBe(false);
  });
});
