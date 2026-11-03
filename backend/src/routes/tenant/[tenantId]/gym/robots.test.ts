/**
 * Robots: management by owners and admins, reading by every member, the
 * capability sections, the photo, and where a robot is (set on the cell).
 *   bun run test:local ./src/routes/tenant/[tenantId]/gym/robots.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import type { SymbiosikaFrameworkHonoApp } from "@framework/types";
import { initTests, TEST_ORG1_USER_2, TEST_ORGANISATION_1, TEST_ORGANISATION_2 } from "@framework/test/init.test";
import { generateUserSessionJwt } from "@framework/lib/auth";
import { testFetcher } from "@framework/test/fetcher.test";
import { getDb } from "@framework/lib/db/db-connection";
import { auditLog, cells, robots } from "../../../../db/schema";
import defineMasterDataRoutes from "./master-data";
import defineRobotRoutes from "./robots";

let app: SymbiosikaFrameworkHonoApp;
let ownerToken: string;
/** a plain member of the organisation (no admin role) */
let memberToken: string;
/** a user of another organisation */
let otherOrgToken: string;
const T = TEST_ORGANISATION_1.id;
const base = `/tenant/${T}/gym`;

const cleanup = async () => {
  const db = getDb();
  await db.delete(auditLog).where(eq(auditLog.tenantId, T));
  await db.delete(cells).where(eq(cells.tenantId, T));
  await db.delete(robots).where(eq(robots.tenantId, T));
  await db.delete(robots).where(eq(robots.tenantId, TEST_ORGANISATION_2.id));
};

const actions = async (robotId: string) =>
  ((await testFetcher.get(app, `${base}/robots/${robotId}/audit`, memberToken)).jsonResponse as { action: string; details: Record<string, unknown> }[])
    .map((a) => a.action)
    .reverse();

describe("Robots", () => {
  let robotId = "";
  let cellA = "";
  let cellB = "";

  beforeAll(async () => {
    const tokens = await initTests();
    ownerToken = tokens.user1Token;
    memberToken = (await generateUserSessionJwt({ email: TEST_ORG1_USER_2.email, id: TEST_ORG1_USER_2.id, firstname: "", surname: "" }, 86400)).token;
    otherOrgToken = tokens.user2Token;
    app = new Hono();
    defineMasterDataRoutes(app);
    defineRobotRoutes(app);
    await cleanup();
  });
  afterAll(async () => {
    await cleanup().catch((error) => console.warn("afterAll cleanup failed:", error));
  });

  test("members read, only owners and admins write, other organisations see nothing", async () => {
    expect((await testFetcher.get(app, `${base}/robots`, undefined)).status).toBe(401);
    expect((await testFetcher.get(app, `${base}/robots`, memberToken)).status).toBe(200);
    expect((await testFetcher.post(app, `${base}/robots`, memberToken, { technicalName: "x" })).status).toBe(403);
    expect((await testFetcher.get(app, `${base}/robots`, otherOrgToken)).status).toBe(403);
  });

  test("create a robot with its capabilities", async () => {
    const created = await testFetcher.post(app, `${base}/robots`, ownerToken, {
      technicalName: "MAiRA 001",
      personalName: "Mia",
      platform: { manufacturer: "NEURA Robotics", model: "MAiRA" },
      capabilities: {
        sensors: [
          { name: "Intel RealSense D435", type: "RGB-D camera", quantity: 2, status: "ok" },
          { name: "Wrist camera", type: "RGB camera", status: "degraded", note: "flickers" },
        ],
        communication: [{ name: "Intel AX210", type: "Wi-Fi card", quantity: 2, status: "faulty" }],
      },
    });
    expect(created.status).toBe(201);
    const r = created.jsonResponse;
    robotId = r.id;
    expect(r.status).toBe("in_service");
    expect(r.cell).toBeNull();
    expect(r.hasImage).toBe(false);
    expect(r.platform).toEqual({ manufacturer: "NEURA Robotics", model: "MAiRA", serialNumber: "", firmware: "" });
    expect(Object.keys(r.capabilities)).toEqual(["sensors", "actuators", "locomotion", "compute", "communication"]);
    expect(r.capabilities.sensors[1]).toMatchObject({ quantity: 1, note: "flickers", status: "degraded" });
    expect(r.capabilities.sensors[0].id).toBeTruthy();
    // health counts components, not their quantity
    expect(r.health).toEqual({ ok: 1, degraded: 1, faulty: 1, unknown: 0 });

    expect((await testFetcher.post(app, `${base}/robots`, ownerToken, { technicalName: "MAiRA 001" })).status).toBe(400);
    expect((await testFetcher.post(app, `${base}/robots`, ownerToken, { technicalName: "" })).status).toBe(400);
    expect((await testFetcher.post(app, `${base}/robots`, ownerToken, { technicalName: "y", status: "broken" })).status).toBe(400);
  });

  test("a section sent replaces that section, the others stay", async () => {
    const before = (await testFetcher.get(app, `${base}/robots/${robotId}`, memberToken)).jsonResponse;
    const sensorId = before.capabilities.sensors[0].id;
    const updated = await testFetcher.put(app, `${base}/robots/${robotId}`, ownerToken, {
      status: "maintenance",
      platform: { firmware: "2.4.1" },
      capabilities: { compute: [{ name: "Jetson AGX Orin", type: "GPU", status: "ok" }] },
    });
    expect(updated.status).toBe(200);
    const r = updated.jsonResponse;
    expect(r.status).toBe("maintenance");
    expect(r.platform.manufacturer).toBe("NEURA Robotics");
    expect(r.platform.firmware).toBe("2.4.1");
    expect(r.capabilities.sensors[0].id).toBe(sensorId);
    expect(r.capabilities.compute).toHaveLength(1);
    expect(r.capabilities.communication).toHaveLength(1);
    expect((await testFetcher.put(app, `${base}/robots/${robotId}`, memberToken, { notes: "x" })).status).toBe(403);
  });

  test("a cell starts undefined, says no robot yet, or holds a robot", async () => {
    const a = await testFetcher.post(app, `${base}/cells`, ownerToken, { name: "Cell A" });
    expect(a.jsonResponse).toMatchObject({ robotId: null, noRobot: false });
    cellA = a.jsonResponse.id;
    const b = await testFetcher.post(app, `${base}/cells`, ownerToken, { name: "Cell B", noRobot: true });
    expect(b.jsonResponse).toMatchObject({ robotId: null, noRobot: true });
    cellB = b.jsonResponse.id;

    const placed = await testFetcher.put(app, `${base}/cells/${cellA}`, ownerToken, { robotId });
    expect(placed.jsonResponse).toMatchObject({ robotId, noRobot: false });
    const r = (await testFetcher.get(app, `${base}/robots/${robotId}`, memberToken)).jsonResponse;
    expect(r.cell).toMatchObject({ id: cellA, name: "Cell A" });
    const listed = (await testFetcher.get(app, `${base}/robots`, memberToken)).jsonResponse;
    expect(listed.find((x: { id: string }) => x.id === robotId).cell.name).toBe("Cell A");

    // saving the cell with the same robot moves nothing
    await testFetcher.put(app, `${base}/cells/${cellA}`, ownerToken, { robotId, location: "Hall 2" });
    expect(await actions(robotId)).toEqual(["robot.created", "robot.updated", "robot.assigned"]);
  });

  test("putting a robot into another cell takes it out of the first", async () => {
    const moved = await testFetcher.put(app, `${base}/cells/${cellB}`, ownerToken, { robotId });
    expect(moved.jsonResponse).toMatchObject({ robotId, noRobot: false });
    const all = (await testFetcher.get(app, `${base}/cells`, memberToken)).jsonResponse as { id: string; robotId: string | null }[];
    expect(all.find((c) => c.id === cellA)!.robotId).toBeNull();
    expect((await testFetcher.get(app, `${base}/robots/${robotId}`, memberToken)).jsonResponse.cell.id).toBe(cellB);
    const audit = (await testFetcher.get(app, `${base}/robots/${robotId}/audit`, memberToken)).jsonResponse;
    expect(audit[0]).toMatchObject({ action: "robot.assigned", details: { cellName: "Cell B", fromCellName: "Cell A" } });

    // "no robot yet" takes the robot out
    const none = await testFetcher.put(app, `${base}/cells/${cellB}`, ownerToken, { noRobot: true });
    expect(none.jsonResponse).toMatchObject({ robotId: null, noRobot: true });
    expect((await testFetcher.get(app, `${base}/robots/${robotId}`, memberToken)).jsonResponse.cell).toBeNull();
    expect((await actions(robotId)).at(-1)).toBe("robot.unassigned");
  });

  test("a robot of another organisation cannot be put into a cell", async () => {
    const [foreign] = await getDb().insert(robots).values({ tenantId: TEST_ORGANISATION_2.id, technicalName: "foreign" }).returning();
    expect((await testFetcher.put(app, `${base}/cells/${cellA}`, ownerToken, { robotId: foreign!.id })).status).toBe(404);
    expect((await testFetcher.get(app, `${base}/robots/${foreign!.id}`, memberToken)).status).toBe(404);
  });

  test("photo: upload, read, remove", async () => {
    const form = new FormData();
    form.append("file", new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], "mia.jpg", { type: "image/jpeg" }));
    const up = await app.request(`${base}/robots/${robotId}/image`, { method: "POST", headers: { Authorization: `Bearer ${ownerToken}` }, body: form });
    expect(up.status).toBe(200);
    expect(((await up.json()) as { hasImage: boolean }).hasImage).toBe(true);
    const img = await app.request(`${base}/robots/${robotId}/image`, { headers: { Authorization: `Bearer ${memberToken}` } });
    expect(img.status).toBe(200);
    expect(img.headers.get("content-type")).toBe("image/jpeg");

    const bad = new FormData();
    bad.append("file", new File(["x"], "x.txt", { type: "text/plain" }));
    expect((await app.request(`${base}/robots/${robotId}/image`, { method: "POST", headers: { Authorization: `Bearer ${ownerToken}` }, body: bad })).status).toBe(400);

    expect((await testFetcher.delete(app, `${base}/robots/${robotId}/image`, ownerToken)).jsonResponse.hasImage).toBe(false);
    expect((await app.request(`${base}/robots/${robotId}/image`, { headers: { Authorization: `Bearer ${memberToken}` } })).status).toBe(404);
  });

  test("deleting a robot leaves its cell with an undefined robot", async () => {
    await testFetcher.put(app, `${base}/cells/${cellA}`, ownerToken, { robotId });
    expect((await testFetcher.delete(app, `${base}/robots/${robotId}`, memberToken)).status).toBe(403);
    expect((await testFetcher.delete(app, `${base}/robots/${robotId}`, ownerToken)).status).toBe(204);
    const all = (await testFetcher.get(app, `${base}/cells`, memberToken)).jsonResponse as { id: string; robotId: string | null; noRobot: boolean }[];
    expect(all.find((c) => c.id === cellA)).toMatchObject({ robotId: null, noRobot: false });
    expect((await testFetcher.get(app, `${base}/robots/${robotId}`, memberToken)).status).toBe(404);
  });
});
