/**
 * Gym MCP tools against the real routes, in process. The framework's request
 * context is emulated with a `fetchApi` that dispatches to a Hono app carrying
 * the gym routes, authenticated with a session token.
 *   bun run test:local ./src/mcp/index.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import type { McpRequestContext, McpToolResult, SymbiosikaFrameworkHonoApp } from "@framework/types";
import { initTests, TEST_ORGANISATION_1 } from "@framework/test/init.test";
import { getDb } from "@framework/lib/db/db-connection";
import { cells, dayProtocols, skills } from "../db/schema";
import defineGymRoutes from "../routes/tenant/[tenantId]/gym";
import { gymMcpServer } from "./index";
import { gymTools } from "./tools";

const T = TEST_ORGANISATION_1.id;
let app: SymbiosikaFrameworkHonoApp;
let ctx: McpRequestContext;

const tool = (name: string) => gymTools.find((t) => t.name === name)!;
const call = async (name: string, args: unknown) => (await tool(name).handler(args, ctx)) as McpToolResult;
const text = (r: McpToolResult) => (r.content[0] as unknown as { text: string }).text;
const data = (r: McpToolResult) => JSON.parse(text(r));

const cleanup = async () => {
  const db = getDb();
  await db.delete(skills).where(eq(skills.tenantId, T));
  await db.delete(dayProtocols).where(eq(dayProtocols.tenantId, T));
  await db.delete(cells).where(eq(cells.tenantId, T));
};

const post = (path: string, body: unknown) =>
  ctx.fetchApi(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("Gym MCP server", () => {
  beforeAll(async () => {
    const { user1Token } = await initTests();
    app = new Hono();
    defineGymRoutes(app, "/api/v1");
    ctx = {
      usersId: "",
      tenantId: T,
      scopes: [],
      tokenKind: "session",
      fetchApi: async (path, init) =>
        app.request(path, { ...init, headers: { ...(init?.headers as Record<string, string>), Authorization: `Bearer ${user1Token}` } }),
    };
    await cleanup();
  });
  afterAll(async () => {
    await cleanup().catch((e) => console.warn("afterAll cleanup failed:", e));
  });

  test("definition is sound and read-only", () => {
    expect(gymMcpServer.path).toBe("/mcp");
    expect(gymTools.map((t) => t.name)).toContain("get_kpis");
    expect(gymTools.map((t) => t.name)).toContain("get_skill");
    for (const t of gymTools) {
      expect(t.description.length).toBeGreaterThan(20);
      expect((t.annotations as { readOnlyHint: boolean }).readOnlyHint).toBe(true);
    }
  });

  test("cells, skills, day protocols, blocks and kpis round trip", async () => {
    const created = await post(`/api/v1/tenant/${T}/gym/cells`, { name: "MCP cell" });
    expect(created.status).toBe(201);
    const cell = (await created.json()) as { id: string };
    const listed = data(await call("list_cells", {}));
    expect(listed.map((c: { name: string }) => c.name)).toContain("MCP cell");

    const skillRes = await post(`/api/v1/tenant/${T}/gym/skills`, { name: "MCP skill", taskDescription: "stack the blocks" });
    expect(skillRes.status).toBe(201);
    const skill = (await skillRes.json()) as { id: string };
    const started = await post(`/api/v1/tenant/${T}/gym/blocks`, { cellId: cell.id, skillId: skill.id, date: "2026-01-05" });
    expect(started.status).toBe(201);
    const { block } = (await started.json()) as { block: { id: string } };

    const skillsResult = data(await call("list_skills", { status: "active" }));
    expect(skillsResult.some((s: { id: string }) => s.id === skill.id)).toBe(true);
    const one = data(await call("get_skill", { skillId: skill.id }));
    expect(one.blocks_).toHaveLength(1);
    expect(one.evaluations).toEqual([]);
    const days = data(await call("list_day_protocols", { from: "2026-01-01", to: "2026-01-31" }));
    expect(days).toHaveLength(1);
    const day = data(await call("get_day_protocol", { dayProtocolId: days[0].id }));
    expect(day.blocks[0].step).toBe("brief");
    expect(day.blocks[0].accessToken).toBeUndefined();
    const b = data(await call("get_block", { blockId: block.id }));
    expect(b.kind).toBe("recording");
    expect(b.skill.name).toBe("MCP skill");
    const blocksResult = data(await call("list_blocks", { skillId: skill.id }));
    expect(blocksResult).toHaveLength(1);
    const kpis = data(await call("get_kpis", { from: "2026-01-01", to: "2026-01-31" }));
    expect(kpis.totals.days).toBe(1);
    expect(kpis.totals.skills).toBe(1);
    expect(kpis.totals.blocks).toBe(1);
    const audit = data(await call("get_skill_audit", { skillId: skill.id }));
    expect(audit.map((a: { action: string }) => a.action)).toContain("skill.created");
    expect(audit.map((a: { action: string }) => a.action)).toContain("block.started");
    const dayAudit = data(await call("get_day_protocol_audit", { dayProtocolId: days[0].id }));
    expect(dayAudit.map((a: { action: string }) => a.action)).toContain("day.created");
  });

  test("errors are readable tool errors", async () => {
    const r = await call("get_skill", { skillId: "00000000-0000-0000-0000-000000000000" });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/404/);
    expect(() => tool("list_cells").handler({}, { ...ctx, tenantId: undefined })).toThrow(/No organisation/);
  });
});
