/**
 * The public app info: name and the version of GYM, readable before login.
 *   bun run test:local ./src/routes/public/app-info.test.ts
 */
import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import pkg from "../../../package.json";
import defineAppInfoRoutes from "./app-info";

describe("App info", () => {
  test("names the version of GYM, without a session", async () => {
    const app = new Hono();
    defineAppInfoRoutes(app as never);
    const res = await app.request("/app-info");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { version: string };
    expect(body.version).toBe(pkg.version);
    expect(body.version).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
