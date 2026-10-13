/**
 * The storage gate: the driver comes from the configuration, the framework
 * does the storing, the reference carries the driver, and what was written
 * with one driver stays readable when the configuration moves to another.
 *   bun run test:local ./src/lib/storage/index.test.ts
 */
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { getDb } from "@framework/lib/db/db-connection";
import { files } from "@framework/lib/db/schema/files";
import { initTests, TEST_ORGANISATION_1 } from "@framework/test/init.test";
import { assertStorageConfigured, buildRef, parseRef, putFile, readFile, removeFile, storageDriver } from ".";

const T = TEST_ORGANISATION_1.id;
const BUCKET = "gym-storage-test";

const setDriver = (value?: string) => {
  if (value === undefined) delete process.env.GYM_STORAGE_DRIVER;
  else process.env.GYM_STORAGE_DRIVER = value;
};

beforeAll(async () => {
  await initTests();
});

afterEach(() => {
  setDriver();
  delete process.env.S3_BUCKET;
});

describe("storage driver", () => {
  test("the database is the default and an unknown driver is refused", () => {
    expect(storageDriver()).toBe("db");
    setDriver("db");
    expect(storageDriver()).toBe("db");
    setDriver("s3");
    expect(storageDriver()).toBe("s3");
    setDriver("azure");
    expect(() => storageDriver()).toThrow(/not a storage driver/);
  });

  test("a configuration that cannot work is refused at start-up, not at the first upload", () => {
    setDriver("local");
    expect(assertStorageConfigured()).toBe("local");
    // an object store without a bucket: the framework says what is missing,
    // GYM only asks it
    setDriver("s3");
    expect(() => assertStorageConfigured()).toThrow(/S3_BUCKET/);
    process.env.S3_BUCKET = "gym";
    expect(assertStorageConfigured()).toBe("s3");
  });

  test("a reference carries its driver, one without a driver is a file from before", () => {
    expect(parseRef("db:abc")).toEqual({ driver: "db", name: "abc" });
    expect(parseRef("s3:abc.jpg")).toEqual({ driver: "s3", name: "abc.jpg" });
    expect(parseRef("local:abc.jpg")).toEqual({ driver: "local", name: "abc.jpg" });
    // an id without a prefix, and anything that only looks like one, is in the database
    expect(parseRef("2f1c9f0a-0000-0000-0000-000000000000")).toEqual({ driver: "db", name: "2f1c9f0a-0000-0000-0000-000000000000" });
    expect(parseRef("azure:abc")).toEqual({ driver: "db", name: "azure:abc" });
    expect(buildRef("s3", "abc.jpg")).toBe("s3:abc.jpg");
  });
});

describe("the database driver", () => {
  test("stores through the framework, reads back and deletes", async () => {
    const file = new File([new Uint8Array([1, 2, 3, 4])], "scene.png", { type: "image/png" });
    const saved = await putFile(T, BUCKET, file);
    expect(saved.driver).toBe("db");
    expect(saved.ref.startsWith("db:")).toBe(true);
    expect(saved.bytes).toBe(4);

    // the bytes are a row of the framework's files table, nothing of the app's own
    const rows = await getDb().select().from(files).where(eq(files.bucket, BUCKET));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe("scene.png");
    expect(new Uint8Array(rows[0]!.file)).toEqual(new Uint8Array([1, 2, 3, 4]));

    const read = await readFile(T, BUCKET, saved.ref);
    expect(new Uint8Array(await read.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(read.type).toBe("image/png");

    await removeFile(T, BUCKET, saved.ref);
    expect(await getDb().select().from(files).where(eq(files.bucket, BUCKET))).toHaveLength(0);
  });

  test("a file written before the drivers existed is still read from the database", async () => {
    const saved = await putFile(T, BUCKET, new File(["old"], "old.txt", { type: "text/plain" }));
    // the reference a row carried before lib/storage: the bare id, no driver
    const legacy = saved.ref.slice("db:".length);
    expect(legacy).toBe(saved.name);
    expect(await (await readFile(T, BUCKET, legacy)).text()).toBe("old");
    await removeFile(T, BUCKET, legacy);
  });

  test("the object store is reached through the gate, and a file stays with its driver", async () => {
    // a stand-in object store, so the whole path is walked without a service:
    // the gate has to hand the s3 backend the name with its extension, the way
    // the disc wants it, and not the bare id the database wants
    const objects = new Map<string, Uint8Array>();
    const store = Bun.serve({
      port: 0,
      async fetch(request) {
        const key = new URL(request.url).pathname;
        if (request.method === "PUT") {
          objects.set(key, new Uint8Array(await request.arrayBuffer()));
          return new Response(null, { status: 200 });
        }
        if (request.method === "GET") {
          const object = objects.get(key);
          return object ? new Response(object) : new Response("NoSuchKey", { status: 404 });
        }
        if (request.method === "DELETE") {
          objects.delete(key);
          return new Response(null, { status: 204 });
        }
        return new Response(null, { status: 405 });
      },
    });
    try {
      setDriver("s3");
      process.env.S3_BUCKET = "gym";
      process.env.S3_ENDPOINT = `http://127.0.0.1:${store.port}`;
      process.env.S3_REGION = "us-east-1";
      process.env.S3_ACCESS_KEY_ID = "test-key";
      process.env.S3_SECRET_ACCESS_KEY = "test-secret";

      const saved = await putFile(T, BUCKET, new File([new Uint8Array([9, 8, 7])], "scene.png", { type: "image/png" }));
      expect(saved.driver).toBe("s3");
      expect(saved.ref).toBe(`s3:${saved.name}`);
      expect(saved.name.endsWith(".png")).toBe(true);
      // the tenant is part of the key, so nothing of one organisation lies in another
      expect([...objects.keys()]).toEqual([`/gym/${T}/${BUCKET}/${saved.name}`]);

      const read = await readFile(T, BUCKET, saved.ref);
      expect(new Uint8Array(await read.arrayBuffer())).toEqual(new Uint8Array([9, 8, 7]));
      expect(read.type).toBe("image/png");

      await removeFile(T, BUCKET, saved.ref);
      expect(objects.size).toBe(0);
    } finally {
      store.stop(true);
      for (const key of ["S3_ENDPOINT", "S3_REGION", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"]) delete process.env[key];
    }
  });

  test("a file stays with its driver when the configuration moves on", async () => {
    const saved = await putFile(T, BUCKET, new File(["kept"], "kept.txt", { type: "text/plain" }));
    setDriver("s3");
    process.env.S3_BUCKET = "gym";
    // new files would go to the object store, this one is still read from the database
    expect(storageDriver()).toBe("s3");
    expect(await (await readFile(T, BUCKET, saved.ref)).text()).toBe("kept");
    await removeFile(T, BUCKET, saved.ref);
    expect(await getDb().select().from(files).where(eq(files.bucket, BUCKET))).toHaveLength(0);
  });
});
