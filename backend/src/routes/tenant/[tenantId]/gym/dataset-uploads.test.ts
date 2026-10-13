/**
 * Chunked dataset uploads: a zip that arrives in pieces, resumes after an
 * interruption and ends as one dataset at the critics. The point of the whole
 * path is that no single request carries the archive (see
 * lib/gym/dataset-uploads.ts), so the chunk size is turned down here and the
 * "archive" is a handful of bytes.
 *   bun run test:local ./src/routes/tenant/[tenantId]/gym/dataset-uploads.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "fs/promises";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import type { SymbiosikaFrameworkHonoApp } from "@framework/types";
import { initTests, TEST_ORGANISATION_1, TEST_ORGANISATION_2 } from "@framework/test/init.test";
import { testFetcher } from "@framework/test/fetcher.test";
import { getDb } from "@framework/lib/db/db-connection";
import { defineFilesRoutes } from "@framework/routes/tenant/[tenantId]/files";
import { _GLOBAL_SERVER_CONFIG } from "@framework/store";
import { files } from "@framework/lib/db/schema/files";
import { cells, datasetUploadChunks, datasetUploads, dayProtocols, skills } from "../../../../db/schema";
import { DATASET_BUCKET, UPLOAD_CHUNK_BUCKET } from "../../../../lib/gym/buckets";
import { cleanupStaleUploads } from "../../../../lib/gym/dataset-uploads";
import { startFakeCritics, type FakeCritics } from "../../../../lib/critics/fake-server.test-util";
import defineGymRoutes from "./index";

let app: SymbiosikaFrameworkHonoApp;
let token: string;
/** a user of another organisation */
let token2: string;
let critics: FakeCritics;
let storage = "";
/** the app on a real port, so the link GYM hands the critics can actually be fetched */
let server: ReturnType<typeof Bun.serve>;
let originalBaseUrl = "";
let originalBasePath = "";
const T = TEST_ORGANISATION_1.id;
const base = `/tenant/${T}/gym`;

/** small enough to see several chunks, the assembly and a resume without moving data */
const CHUNK = 8;
/** the stand-in for a zipped LeRobot dataset: 20 bytes are three chunks of 8 */
const ZIP = new Uint8Array(Array.from({ length: 20 }, (_, i) => i + 1));
ZIP.set([0x50, 0x4b, 0x03, 0x04], 0);

const cleanup = async () => {
  const db = getDb();
  await db.delete(skills).where(eq(skills.tenantId, T));
  await db.delete(dayProtocols).where(eq(dayProtocols.tenantId, T));
  await db.delete(cells).where(eq(cells.tenantId, T));
};

/** The chunk rows of all uploads: the record of what arrived. */
const chunkRows = () => getDb().select().from(datasetUploadChunks);

/** The chunks as the framework stored them, proving they went through the storage and not onto a disc. */
const storedChunkFiles = () => getDb().select().from(files).where(eq(files.bucket, UPLOAD_CHUNK_BUCKET));

/** The assembled datasets, which GYM keeps and the critics only ever borrow. */
const storedDatasets = () => getDb().select().from(files).where(eq(files.bucket, DATASET_BUCKET));

/** PUT one chunk with the bytes as the raw body; testFetcher only speaks JSON. */
const putChunk = async (path: string, body: Uint8Array, bearer = token) => {
  const res = await app.request(path, {
    method: "PUT",
    headers: { "content-type": "application/octet-stream", Authorization: `Bearer ${bearer}` },
    body,
  });
  const text = await res.text();
  let jsonResponse: any;
  try {
    jsonResponse = JSON.parse(text);
  } catch {
    /* an error body is plain text */
  }
  return { status: res.status, jsonResponse, textResponse: text };
};

describe("Chunked dataset uploads", () => {
  let blockId = "";
  let uploads = "";

  beforeAll(async () => {
    const tokens = await initTests();
    token = tokens.user1Token;
    token2 = tokens.user2Token;
    app = new Hono();
    defineGymRoutes(app);
    defineFilesRoutes(app, "");
    server = Bun.serve({ port: 0, fetch: (request) => app.fetch(request) });
    originalBaseUrl = _GLOBAL_SERVER_CONFIG.baseUrl;
    originalBasePath = _GLOBAL_SERVER_CONFIG.basePath;
    _GLOBAL_SERVER_CONFIG.baseUrl = `http://127.0.0.1:${server.port}`;
    _GLOBAL_SERVER_CONFIG.basePath = "";
    critics = startFakeCritics();
    process.env.CRITICS_URL = critics.url;
    process.env.GYM_UPLOAD_CHUNK_SIZE = String(CHUNK);
    storage = await fs.mkdtemp("/tmp/gym-upload-test-");
    process.env.TEMPORARY_STORAGE_PATH = storage;
    await cleanup();

    const cell = await testFetcher.post(app, `${base}/cells`, token, { name: "Cell 7", robot: "MAiRA" });
    const skill = await testFetcher.post(app, `${base}/skills`, token, { name: "Block to box", taskDescription: "Put the block in the box" });
    const started = await testFetcher.post(app, `${base}/blocks`, token, {
      cellId: cell.jsonResponse.id,
      skillId: skill.jsonResponse.id,
      date: "2026-09-22",
    });
    blockId = started.jsonResponse.block.id;
    uploads = `${base}/blocks/${blockId}/datasets/uploads`;
  });

  afterAll(async () => {
    critics.stop();
    server?.stop(true);
    _GLOBAL_SERVER_CONFIG.baseUrl = originalBaseUrl;
    _GLOBAL_SERVER_CONFIG.basePath = originalBasePath;
    delete process.env.CRITICS_URL;
    delete process.env.GYM_UPLOAD_CHUNK_SIZE;
    delete process.env.TEMPORARY_STORAGE_PATH;
    if (storage) await fs.rm(storage, { recursive: true, force: true }).catch(() => undefined);
    await cleanup().catch((error) => console.warn("afterAll cleanup failed:", error));
  });

  test("a wrong file is refused before anything is transferred", async () => {
    expect((await testFetcher.post(app, uploads, token, { fileName: "notes.txt", bytes: 20 })).status).toBe(400);
    expect((await testFetcher.post(app, uploads, token, { fileName: "d.zip", bytes: 0 })).status).toBe(400);
    // larger than the guard against a file picked by mistake
    expect((await testFetcher.post(app, uploads, token, { fileName: "d.zip", bytes: 60 * 1000 ** 3 })).status).toBe(400);
  });

  test("a dataset of several gigabytes is announced like any other", async () => {
    // beyond 2^31 bytes: the size lives in a bigint, and nothing is ever held as one piece
    const bytes = 3 * 1000 ** 3 + 5;
    const begun = await testFetcher.post(app, uploads, token, { fileName: "big.zip", bytes });
    expect(begun.status).toBe(201);
    expect(begun.jsonResponse.bytes).toBe(bytes);
    expect(begun.jsonResponse.chunkCount).toBe(Math.ceil(bytes / CHUNK));
    expect((await testFetcher.get(app, `${uploads}/${begun.jsonResponse.uploadId}`, token)).jsonResponse.bytes).toBe(bytes);
    expect((await testFetcher.delete(app, `${uploads}/${begun.jsonResponse.uploadId}`, token)).status).toBe(204);
  });

  test("access: unauthenticated 401, another organisation 403", async () => {
    expect((await testFetcher.post(app, uploads, undefined, { fileName: "d.zip", bytes: 20 })).status).toBe(401);
    expect((await testFetcher.get(app, uploads, token2)).status).toBe(403);
  });

  test("the chunk plan comes from the announced size", async () => {
    const begun = await testFetcher.post(app, uploads, token, { fileName: "block_box_a.zip", bytes: ZIP.length, name: "Block box A" });
    expect(begun.status).toBe(201);
    expect(begun.jsonResponse.chunkSize).toBe(CHUNK);
    expect(begun.jsonResponse.chunkCount).toBe(3);
    expect(begun.jsonResponse.received).toEqual([]);
    await testFetcher.delete(app, `${uploads}/${begun.jsonResponse.uploadId}`, token);
  });

  test("a chunk that does not fit the plan is refused", async () => {
    const begun = await testFetcher.post(app, uploads, token, { fileName: "d.zip", bytes: ZIP.length });
    const id = begun.jsonResponse.uploadId;
    // a full chunk is expected, not a short one
    expect((await putChunk(`${uploads}/${id}/chunks/0`, ZIP.slice(0, 3))).status).toBe(400);
    // the last chunk is the remainder: 20 bytes in chunks of 8 leaves 4
    expect((await putChunk(`${uploads}/${id}/chunks/2`, ZIP.slice(0, 8))).status).toBe(400);
    // and there is no fourth chunk
    expect((await putChunk(`${uploads}/${id}/chunks/3`, ZIP.slice(0, 8))).status).toBe(400);
    // completing without the chunks says what is missing
    const early = await testFetcher.post(app, `${uploads}/${id}/complete`, token, {});
    expect(early.status).toBe(409);
    expect(early.textResponse).toContain("3 chunks are missing");
    expect((await testFetcher.delete(app, `${uploads}/${id}`, token)).status).toBe(204);
    expect((await testFetcher.get(app, `${uploads}/${id}`, token)).status).toBe(404);
  });

  test("an upload in chunks becomes one dataset in parts, and resumes after an interruption", async () => {
    const begun = await testFetcher.post(app, uploads, token, { fileName: "block_box_a.zip", bytes: ZIP.length, name: "Block box A" });
    const id = begun.jsonResponse.uploadId;

    // the operator's browser gets two chunks out and then loses the connection
    expect((await putChunk(`${uploads}/${id}/chunks/0`, ZIP.slice(0, 8))).status).toBe(200);
    const second = await putChunk(`${uploads}/${id}/chunks/1`, ZIP.slice(8, 16));
    expect(second.jsonResponse.received).toEqual([0, 1]);

    // picking the upload up again says what is still missing
    const resumed = await testFetcher.get(app, `${uploads}/${id}`, token);
    expect(resumed.status).toBe(200);
    expect(resumed.jsonResponse.received).toEqual([0, 1]);
    expect(resumed.jsonResponse.chunkCount).toBe(3);
    // an unclear failure may have sent a chunk twice; that must not corrupt the zip
    expect((await putChunk(`${uploads}/${id}/chunks/1`, ZIP.slice(8, 16))).status).toBe(200);
    expect((await putChunk(`${uploads}/${id}/chunks/2`, ZIP.slice(16, 20))).status).toBe(200);
    expect((await testFetcher.get(app, `${uploads}`, token)).jsonResponse).toHaveLength(1);

    const done = await testFetcher.post(app, `${uploads}/${id}/complete`, token, {});
    expect(done.status).toBe(201);
    expect(done.jsonResponse.name).toBe("Block box A");
    expect(done.jsonResponse.bytes).toBe(ZIP.length);
    expect(done.jsonResponse.sourceFileName).toBe("block_box_a.zip");
    expect(done.jsonResponse.criticsJobId).toBe("job_1");
    expect(done.jsonResponse.criticsDatasetName).toMatch(/^Block_box_A_20260922_/);

    // the zip is never put together here: the chunks are the dataset, and the
    // critics are handed one link per chunk, in order, and join them. What
    // they fetch adds up to the whole zip.
    expect(critics.uploads).toHaveLength(0);
    const job = critics.jobs.at(-1)!;
    expect(job.parts).toHaveLength(3);
    for (const link of job.parts!) expect(link).toMatch(/^https?:\/\//);
    expect(critics.fetched).toHaveLength(3);
    expect(critics.fetched.every((f) => f.status === 200)).toBe(true);
    expect(critics.fetched.map((f) => f.bytes)).toEqual([8, 8, 4]);
    expect(critics.fetched[0]!.head).toEqual([0x50, 0x4b, 0x03, 0x04]);

    // GYM keeps the data, as the chunks it arrived in, in order; no second copy
    expect(done.jsonResponse.storageRef).toBeNull();
    expect(done.jsonResponse.storageParts).toHaveLength(3);
    expect(await storedDatasets()).toHaveLength(0);
    const parts = await storedChunkFiles();
    expect(parts).toHaveLength(3);
    const byName = new Map(parts.map((f) => [`db:${f.id}`, new Uint8Array(f.file)]));
    const joined = (done.jsonResponse.storageParts as string[]).flatMap((ref) => [...byName.get(ref)!]);
    expect(new Uint8Array(joined)).toEqual(ZIP);

    // the block moved on, exactly as after a single-request upload
    const block = await testFetcher.get(app, `${base}/blocks/${blockId}`, token);
    expect(block.jsonResponse.step).toBe("review");
    expect(block.jsonResponse.datasets).toHaveLength(1);

    // nothing is left of the upload itself: no row, no chunk row, no scratch file
    expect((await testFetcher.get(app, uploads, token)).jsonResponse).toEqual([]);
    expect(await chunkRows()).toHaveLength(0);
    expect(await fs.readdir(`${storage}/gym-uploads`).catch(() => [])).toEqual([]);
    // and the parts are not an abandoned upload to the cleanup
    await cleanupStaleUploads();
    expect(await storedChunkFiles()).toHaveLength(3);

    // deleting the dataset takes its parts with it
    expect((await testFetcher.delete(app, `${base}/datasets/${done.jsonResponse.id}`, token)).status).toBe(204);
    expect(await storedChunkFiles()).toHaveLength(0);
  });

  test("a completion sent twice makes one dataset, and a deleted block takes the parts along", async () => {
    const begun = await testFetcher.post(app, uploads, token, { fileName: "twice.zip", bytes: ZIP.length });
    const id = begun.jsonResponse.uploadId;
    await putChunk(`${uploads}/${id}/chunks/0`, ZIP.slice(0, 8));
    await putChunk(`${uploads}/${id}/chunks/1`, ZIP.slice(8, 16));
    await putChunk(`${uploads}/${id}/chunks/2`, ZIP.slice(16, 20));
    const done = await testFetcher.post(app, `${uploads}/${id}/complete`, token, {});
    expect(done.status).toBe(201);
    // a retry after an unclear failure (a timeout on the way back) finds the
    // upload gone and makes no second dataset of the same chunks
    expect((await testFetcher.post(app, `${uploads}/${id}/complete`, token, {})).status).toBe(404);
    const datasetId = done.jsonResponse.id;
    expect((await testFetcher.get(app, `${base}/blocks/${blockId}`, token)).jsonResponse.datasets).toHaveLength(1);

    // deleting the block takes the parts of its datasets with it
    const other = await testFetcher.post(app, `${base}/blocks`, token, {
      cellId: (await testFetcher.get(app, `${base}/cells`, token)).jsonResponse[0].id,
      skillId: (await testFetcher.get(app, `${base}/skills`, token)).jsonResponse[0].id,
      date: "2026-09-24",
    });
    const otherUploads = `${base}/blocks/${other.jsonResponse.block.id}/datasets/uploads`;
    const second = await testFetcher.post(app, otherUploads, token, { fileName: "gone.zip", bytes: 8 });
    await putChunk(`${otherUploads}/${second.jsonResponse.uploadId}/chunks/0`, ZIP.slice(0, 8));
    expect((await testFetcher.post(app, `${otherUploads}/${second.jsonResponse.uploadId}/complete`, token, {})).status).toBe(201);
    expect(await storedChunkFiles()).toHaveLength(4);
    expect((await testFetcher.delete(app, `${base}/blocks/${other.jsonResponse.block.id}`, token)).status).toBe(204);
    expect(await storedChunkFiles()).toHaveLength(3);

    expect((await testFetcher.delete(app, `${base}/datasets/${datasetId}`, token)).status).toBe(204);
    expect(await storedChunkFiles()).toHaveLength(0);
  });

  test("the chunks lie in the configured storage, not on the disc of the container", async () => {
    const begun = await testFetcher.post(app, uploads, token, { fileName: "in_storage.zip", bytes: ZIP.length });
    const id = begun.jsonResponse.uploadId;
    await putChunk(`${uploads}/${id}/chunks/0`, ZIP.slice(0, 8));

    // the default driver is the database, so the framework's files table holds the bytes
    const stored = await storedChunkFiles();
    expect(stored).toHaveLength(1);
    expect(new Uint8Array(stored[0]!.file)).toEqual(ZIP.slice(0, 8));
    // and the row says where they are, with the driver in front
    const rows = await chunkRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.index).toBe(0);
    expect(rows[0]!.bytes).toBe(8);
    expect(rows[0]!.storageRef.startsWith("db:")).toBe(true);
    // nothing of the upload touched the disc
    expect(await fs.readdir(`${storage}/gym-uploads`).catch(() => [])).toEqual([]);

    // sending the chunk again replaces the stored bytes instead of adding a second copy
    await putChunk(`${uploads}/${id}/chunks/0`, ZIP.slice(8, 16));
    expect(await storedChunkFiles()).toHaveLength(1);
    expect(await chunkRows()).toHaveLength(1);

    // dropping the upload takes the bytes with it
    expect((await testFetcher.delete(app, `${uploads}/${id}`, token)).status).toBe(204);
    expect(await chunkRows()).toHaveLength(0);
    expect(await storedChunkFiles()).toHaveLength(0);
  });

  test("an upload nobody came back for is cleaned up, an open one is kept", async () => {
    const stale = await testFetcher.post(app, uploads, token, { fileName: "forgotten.zip", bytes: ZIP.length });
    const staleId = stale.jsonResponse.uploadId;
    await putChunk(`${uploads}/${staleId}/chunks/0`, ZIP.slice(0, 8));
    const fresh = await testFetcher.post(app, uploads, token, { fileName: "current.zip", bytes: ZIP.length });

    // the stale one's last sign of life was two days ago
    await getDb()
      .update(datasetUploads)
      .set({ updatedAt: new Date(Date.now() - 48 * 3600 * 1000).toISOString() })
      .where(eq(datasetUploads.id, staleId));

    const cleaned = await cleanupStaleUploads();
    expect(cleaned.uploads).toBe(1);
    expect(cleaned.chunks).toBe(1);
    expect((await testFetcher.get(app, `${uploads}/${staleId}`, token)).status).toBe(404);
    // the stale upload's bytes went with it, the open upload is untouched
    expect(await storedChunkFiles()).toHaveLength(0);
    expect((await testFetcher.get(app, `${uploads}/${fresh.jsonResponse.uploadId}`, token)).status).toBe(200);

    // a scratch file of an assembly that was interrupted, or a chunk directory
    // of an older installation, goes too
    await fs.mkdir(`${storage}/gym-uploads`, { recursive: true });
    await fs.writeFile(`${storage}/gym-uploads/00000000-0000-0000-0000-000000000000.zip`, "left over");
    expect((await cleanupStaleUploads()).scratch).toBe(1);
    expect(await fs.readdir(`${storage}/gym-uploads`)).toEqual([]);

    await testFetcher.delete(app, `${uploads}/${fresh.jsonResponse.uploadId}`, token);
  });

  test("the upload of another organisation's block is not reachable", async () => {
    const begun = await testFetcher.post(app, uploads, token, { fileName: "d.zip", bytes: ZIP.length });
    const id = begun.jsonResponse.uploadId;
    expect((await testFetcher.get(app, `/tenant/${TEST_ORGANISATION_2.id}/gym/blocks/${blockId}/datasets/uploads/${id}`, token)).status).toBe(403);
    // the block of the path decides as well, not only the organisation
    const other = await testFetcher.post(app, `${base}/blocks`, token, {
      cellId: (await testFetcher.get(app, `${base}/cells`, token)).jsonResponse[0].id,
      skillId: (await testFetcher.get(app, `${base}/skills`, token)).jsonResponse[0].id,
      date: "2026-09-23",
    });
    const strangerPath = `${base}/blocks/${other.jsonResponse.block.id}/datasets/uploads/${id}`;
    expect((await testFetcher.get(app, strangerPath, token)).status).toBe(404);
    expect((await putChunk(`${strangerPath}/chunks/0`, ZIP.slice(0, 8))).status).toBe(404);
    expect((await testFetcher.delete(app, `${uploads}/${id}`, token)).status).toBe(204);
  });
});
