/**
 * Invitation codes: management by organisation admins and the effect on
 * registration (the framework's magic-link path).
 *   bun run test:local ./src/routes/tenant/[tenantId]/gym/invitation-codes.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import type { SymbiosikaFrameworkHonoApp } from "@framework/types";
import { initTests, TEST_ORGANISATION_1, TEST_ORGANISATION_2 } from "@framework/test/init.test";
import { testFetcher } from "@framework/test/fetcher.test";
import { getDb } from "@framework/lib/db/db-connection";
import { invitationCodes } from "@framework/lib/db/schema/users";
import { checkIfInvitationCodeIsNeededToRegister } from "@framework/lib/usermanagement/invitations";
import { checkGeneralInvitationCode } from "@framework/lib/auth";
import { deactivateExpiredCodes, generateCode } from "../../../../lib/gym/invitation-codes";
import defineInvitationCodeRoutes from "./invitation-codes";

let app: SymbiosikaFrameworkHonoApp;
let ownerToken: string;
let memberToken: string;
const T = TEST_ORGANISATION_1.id;
const base = `/tenant/${T}/gym/invitation-codes`;

const cleanup = () => getDb().delete(invitationCodes).where(eq(invitationCodes.tenantId, T));

describe("Invitation codes", () => {
  beforeAll(async () => {
    const tokens = await initTests();
    ownerToken = tokens.user1Token;
    memberToken = tokens.user3Token;
    app = new Hono();
    defineInvitationCodeRoutes(app);
    await cleanup();
  });
  afterAll(async () => {
    // awaited on purpose: an unawaited delete keeps running into the next test
    // file's initTests(), which recreates the test tenants. With one pooled
    // connection the interleaved queries break the wire protocol.
    await cleanup().catch((error) => console.warn("afterAll cleanup failed:", error));
  });

  test("code format is readable", () => {
    expect(generateCode()).toMatch(/^GYM-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  });

  test("only admins and owners manage codes", async () => {
    expect((await testFetcher.get(app, base, undefined)).status).toBe(401);
    expect((await testFetcher.get(app, base, memberToken)).status).toBe(403);
    expect((await testFetcher.get(app, `/tenant/${TEST_ORGANISATION_2.id}/gym/invitation-codes`, ownerToken)).status).toBe(403);
  });

  test("create, list, deactivate, delete; registration becomes protected", async () => {
    const before = await testFetcher.get(app, base, ownerToken);
    expect(before.status).toBe(200);
    expect(before.jsonResponse.codes).toEqual([]);

    const created = await testFetcher.post(app, base, ownerToken, {});
    expect(created.status).toBe(200);
    const code = created.jsonResponse;
    expect(code.code).toMatch(/^GYM-/);
    expect(code.tenantId).toBe(T);
    expect(code.usable).toBe(true);

    // the framework now demands a code for unknown addresses …
    expect(await checkIfInvitationCodeIsNeededToRegister()).toBe(true);
    // … and accepts this one, pointing at our organisation
    const check = await checkGeneralInvitationCode(code.code);
    expect(check.setTenantId).toBe(T);
    await expect(checkGeneralInvitationCode("GYM-NOPE-NOPE")).rejects.toBeDefined();

    const list = await testFetcher.get(app, base, ownerToken);
    expect(list.jsonResponse.status.protected).toBe(true);
    expect(list.jsonResponse.status.activeCodes).toBe(1);

    const off = await testFetcher.put(app, `${base}/${code.id}`, ownerToken, { isActive: false });
    expect(off.jsonResponse.isActive).toBe(false);
    expect(off.jsonResponse.usable).toBe(false);
    expect(await checkIfInvitationCodeIsNeededToRegister()).toBe(false);

    const past = await testFetcher.post(app, base, ownerToken, { expiresAt: "2000-01-01T00:00:00.000Z" });
    expect(past.status).toBe(400);

    const del = await testFetcher.delete(app, `${base}/${code.id}`, ownerToken);
    expect(del.status).toBe(200);
    expect((await testFetcher.delete(app, `${base}/${code.id}`, ownerToken)).status).toBe(404);
  });

  test("expired codes are switched off by the cron", async () => {
    const soon = new Date(Date.now() + 60_000).toISOString();
    const created = await testFetcher.post(app, base, ownerToken, { expiresAt: soon });
    expect(created.jsonResponse.usable).toBe(true);
    // pretend time passed
    await getDb()
      .update(invitationCodes)
      .set({ expiresAt: new Date(Date.now() - 1000).toISOString() })
      .where(eq(invitationCodes.id, created.jsonResponse.id));
    const list = await testFetcher.get(app, base, ownerToken);
    expect(list.jsonResponse.codes[0].usable).toBe(false);
    expect(list.jsonResponse.codes[0].isActive).toBe(true);
    expect(await deactivateExpiredCodes()).toBe(1);
    const after = await testFetcher.get(app, base, ownerToken);
    expect(after.jsonResponse.codes[0].isActive).toBe(false);
    expect(after.jsonResponse.status.protected).toBe(false);
  });
});
