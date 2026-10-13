/**
 * Resumable dataset uploads: the zip in chunks instead of one long request.
 *
 * A LeRobot dataset is tens to hundreds of megabytes and the cells upload over
 * ordinary uplinks, so one request carries the archive for minutes. Every
 * reverse proxy on the way gives up long before that (Traefik's
 * `respondingTimeouts.readTimeout` is 60 seconds by default and covers reading
 * the whole request body), answers 502 and drops the connection, and the whole
 * upload is lost. Nothing in the app can ask a proxy for more time: there is no
 * header for it and the timeout is static entrypoint configuration.
 *
 * So the app makes sure no request needs it. The browser announces the file,
 * sends it in chunks of a few megabytes, each in its own short request, and
 * asks for completion at the end. A chunk that fails is repeated on its own, an
 * upload that was interrupted resumes with the chunks that are missing, and the
 * operator loses seconds instead of the whole archive.
 *
 * The chunks go into the configured storage (lib/storage: the database or an
 * object store), like every other byte the app keeps, and the
 * `dataset_upload_chunks` rows are the record of what arrived. Nothing of an
 * upload lies on the disc of a container, so a chunk that reaches one replica
 * is assembled by whichever replica is asked to complete the upload, and a
 * container that is replaced mid-upload costs nothing. `complete` reads the
 * chunks back in order, hands the zip to the critics through
 * lib/gym/datasets.ts and drops everything.
 */
import fs from "fs/promises";
import { and, asc, eq, inArray, lt } from "drizzle-orm";
import { getDb } from "@framework/lib/db/db-connection";
import log from "@framework/lib/log";
import { datasetUploadChunks, datasetUploads, type DatasetUploadSelect } from "../../db/schema";
import { putFile, readFile, removeFile } from "../storage";
import { UPLOAD_CHUNK_BUCKET } from "./buckets";
import { assertDatasetZip, createDataset, type DatasetView } from "./datasets";
import { type Actor } from "./audit";
import { getBlockRow } from "./blocks";
import { ConflictError, InvalidInputError, NotFoundError } from "./errors";

/**
 * 8 MiB per chunk: at the ~6 Mbit/s uplink of a cell one chunk takes about ten
 * seconds, well inside every proxy default, and a 65 MB dataset is nine
 * requests rather than nine hundred. GYM_UPLOAD_CHUNK_SIZE lowers it for an
 * installation behind a tighter proxy (and for the tests, which would rather
 * not move megabytes to see the assembly work).
 */
export const DEFAULT_CHUNK_SIZE = 8 * 1024 * 1024;

const chunkSize = (): number => {
  const configured = Number(process.env.GYM_UPLOAD_CHUNK_SIZE);
  return Number.isInteger(configured) && configured > 0 ? configured : DEFAULT_CHUNK_SIZE;
};

/** `datasets.bytes` is an integer column, so this is the ceiling the row can hold. */
export const MAX_UPLOAD_BYTES = 2_000_000_000;

/** An upload with no sign of life for this long is abandoned; the cron job clears it. */
const STALE_AFTER_HOURS = 24;

/**
 * Where the zip is put together. This is scratch space for the one request
 * that completes an upload, not storage: the file is written, handed to the
 * critics and deleted again, and nothing outside that request ever looks for
 * it. Assembling through a file is what keeps an archive of up to two
 * gigabytes out of the memory of the process.
 */
const scratchDir = () => `${process.env.TEMPORARY_STORAGE_PATH || "./tmp"}/gym-uploads`;
const scratchZipPath = (uploadId: string) => `${scratchDir()}/${uploadId}.zip`;

/** What the client needs to drive the upload, and to pick up one that was interrupted. */
export interface DatasetUploadView {
  uploadId: string;
  fileName: string;
  bytes: number;
  chunkSize: number;
  chunkCount: number;
  /** the chunk indexes that arrived, ascending */
  received: number[];
}

/**
 * The chunks that arrived. One row per chunk, and not a list on the upload
 * row: chunks are sent in parallel, and two rows written at the same time
 * cannot lose each other the way two writers of one list would.
 */
async function receivedChunks(uploadId: string): Promise<number[]> {
  const rows = await getDb()
    .select({ index: datasetUploadChunks.index })
    .from(datasetUploadChunks)
    .where(eq(datasetUploadChunks.uploadId, uploadId))
    .orderBy(asc(datasetUploadChunks.index));
  return rows.map((r) => r.index);
}

const toView = (row: DatasetUploadSelect, received: number[]): DatasetUploadView => ({
  uploadId: row.id,
  fileName: row.fileName,
  bytes: row.bytes,
  chunkSize: row.chunkSize,
  chunkCount: row.chunkCount,
  received,
});

/** The upload of this block, or 404. Tenant-scoped like every other read. */
async function getUploadRow(tenantId: string, blockId: string, uploadId: string): Promise<DatasetUploadSelect> {
  const rows = await getDb()
    .select()
    .from(datasetUploads)
    .where(and(eq(datasetUploads.id, uploadId), eq(datasetUploads.tenantId, tenantId), eq(datasetUploads.blockId, blockId)))
    .limit(1);
  if (!rows[0]) throw new NotFoundError("Upload");
  return rows[0];
}

/** Keep the upload out of the cleanup while the operator is still sending. */
const touch = (uploadId: string) =>
  getDb().update(datasetUploads).set({ updatedAt: new Date().toISOString() }).where(eq(datasetUploads.id, uploadId));

/**
 * Announce a dataset upload: the file is checked and its chunk plan is handed
 * back. Nothing is transferred yet, so a wrong file costs one small request.
 */
export async function beginUpload(
  tenantId: string,
  actor: Actor,
  blockId: string,
  file: { fileName: string; bytes: number; displayName?: string },
): Promise<DatasetUploadView> {
  const block = await getBlockRow(tenantId, blockId);
  assertDatasetZip(file.fileName, file.bytes);
  if (file.bytes > MAX_UPLOAD_BYTES) {
    throw new InvalidInputError(`The dataset is larger than ${Math.floor(MAX_UPLOAD_BYTES / 1_000_000_000)} GB; split the recording into several zips`);
  }
  const [row] = await getDb()
    .insert(datasetUploads)
    .values({
      tenantId,
      blockId: block.id,
      fileName: file.fileName.slice(0, 300),
      displayName: (file.displayName ?? "").slice(0, 300),
      bytes: file.bytes,
      chunkSize: chunkSize(),
      chunkCount: Math.ceil(file.bytes / chunkSize()),
      createdBy: actor.userId,
    })
    .returning();
  return toView(row!, []);
}

/** Where an interrupted upload stands, so the client can send only what is missing. */
export async function getUpload(tenantId: string, blockId: string, uploadId: string): Promise<DatasetUploadView> {
  const row = await getUploadRow(tenantId, blockId, uploadId);
  return toView(row, await receivedChunks(uploadId));
}

/** The size chunk `index` must have: the announced size decides, not the client. */
const expectedChunkBytes = (row: DatasetUploadSelect, index: number) =>
  index === row.chunkCount - 1 ? row.bytes - row.chunkSize * (row.chunkCount - 1) : row.chunkSize;

/**
 * Store one chunk. Sending it again overwrites it, so a client that retries
 * after an unclear failure cannot corrupt the archive.
 */
export async function putChunk(
  tenantId: string,
  blockId: string,
  uploadId: string,
  index: number,
  data: ArrayBuffer,
): Promise<DatasetUploadView> {
  const row = await getUploadRow(tenantId, blockId, uploadId);
  if (index >= row.chunkCount) throw new InvalidInputError(`Chunk ${index} is beyond the ${row.chunkCount} chunks of this upload`);
  const expected = expectedChunkBytes(row, index);
  if (data.byteLength !== expected) {
    throw new InvalidInputError(`Chunk ${index} must be ${expected} bytes, received ${data.byteLength}`);
  }
  // What the chunk replaces, if the client is sending it a second time. Read
  // before the write so the bytes it points at can go; two clients sending the
  // same chunk at the very same moment may leave one object behind, which the
  // cleanup below does not find. That costs one chunk and never the archive.
  const previous = (
    await getDb()
      .select({ storageRef: datasetUploadChunks.storageRef })
      .from(datasetUploadChunks)
      .where(and(eq(datasetUploadChunks.uploadId, uploadId), eq(datasetUploadChunks.index, index)))
      .limit(1)
  )[0]?.storageRef;

  const saved = await putFile(tenantId, UPLOAD_CHUNK_BUCKET, new File([data], `${uploadId}-${index}.bin`, { type: "application/octet-stream" }));
  const now = new Date().toISOString();
  await getDb()
    .insert(datasetUploadChunks)
    .values({ tenantId, uploadId, index, storageRef: saved.ref, bytes: data.byteLength })
    .onConflictDoUpdate({
      target: [datasetUploadChunks.uploadId, datasetUploadChunks.index],
      set: { storageRef: saved.ref, bytes: data.byteLength, updatedAt: now },
    });
  if (previous && previous !== saved.ref) await removeFile(tenantId, UPLOAD_CHUNK_BUCKET, previous).catch(() => undefined);
  await touch(uploadId);
  return toView(row, await receivedChunks(uploadId));
}

/**
 * All chunks are in: assemble the zip, hand it to the critics and create the
 * dataset. Assembling appends one chunk at a time, so the archive never sits in
 * memory as a whole.
 *
 * If the critics refuse or cannot be reached the chunks stay where they are and
 * the row survives, so the operator can ask for completion again without
 * sending the data a second time.
 */
export async function completeUpload(tenantId: string, actor: Actor, blockId: string, uploadId: string): Promise<DatasetView> {
  const row = await getUploadRow(tenantId, blockId, uploadId);
  const received = await receivedChunks(uploadId);
  if (received.length !== row.chunkCount) {
    const missing = Array.from({ length: row.chunkCount }, (_, i) => i).filter((i) => !received.includes(i));
    throw new ConflictError(`The upload is incomplete: ${missing.length} of ${row.chunkCount} chunks are missing (${missing.slice(0, 10).join(", ")})`);
  }

  // One chunk at a time, read back from the storage and appended to the
  // scratch file: the archive is never held in memory as a whole. A writer
  // truncates, so a completion that failed half way is simply redone.
  const chunks = await chunkRefs(uploadId);
  const path = scratchZipPath(uploadId);
  await fs.mkdir(scratchDir(), { recursive: true });
  try {
    const sink = Bun.file(path).writer();
    try {
      for (let i = 0; i < row.chunkCount; i++) {
        const ref = chunks.get(i);
        if (!ref) throw new ConflictError(`The upload lost chunk ${i}; upload it again`);
        sink.write(await (await readFile(tenantId, UPLOAD_CHUNK_BUCKET, ref)).arrayBuffer());
      }
    } finally {
      await sink.end();
    }
    const zip = Bun.file(path);
    if (zip.size !== row.bytes) {
      // the chunks do not add up to what was announced: refuse rather than hand
      // the critics half an archive, and let the operator start over
      await dropUpload(tenantId, uploadId);
      throw new InvalidInputError(`The assembled dataset is ${zip.size} bytes, ${row.bytes} were announced; upload it again`);
    }

    const dataset = await createDataset(tenantId, actor, blockId, {
      fileName: row.fileName,
      bytes: row.bytes,
      blob: zip,
      displayName: row.displayName || undefined,
      contentType: "application/zip",
    });
    await dropUpload(tenantId, uploadId);
    return dataset;
  } finally {
    // the scratch file has done its job, whether the critics took the archive
    // or refused it; the chunks are what a second attempt starts from
    await fs.rm(path, { force: true }).catch(() => undefined);
  }
}

/** The storage reference of every chunk of an upload, by index. */
async function chunkRefs(uploadId: string): Promise<Map<number, string>> {
  const rows = await getDb()
    .select({ index: datasetUploadChunks.index, storageRef: datasetUploadChunks.storageRef })
    .from(datasetUploadChunks)
    .where(eq(datasetUploadChunks.uploadId, uploadId));
  return new Map(rows.map((r) => [r.index, r.storageRef]));
}

/**
 * The operator removed the file from the list, or gave up: drop the chunks.
 * Not written to the audit log; no dataset ever entered the gym, and the log is
 * about the work of the day, not about a file that was picked and dropped.
 */
export async function abortUpload(tenantId: string, blockId: string, uploadId: string): Promise<void> {
  await getUploadRow(tenantId, blockId, uploadId);
  await dropUpload(tenantId, uploadId);
}

/**
 * Drop one upload: the bytes of its chunks first, then the row, which takes
 * the chunk rows with it. The bytes go first because the rows are the only
 * record of where they are.
 */
async function dropUpload(tenantId: string, uploadId: string): Promise<void> {
  await dropChunkFiles([uploadId]);
  await getDb().delete(datasetUploads).where(eq(datasetUploads.id, uploadId));
}

/**
 * Remove the bytes of the chunks of these uploads and say how many there were.
 * The rows stay: they go with their upload through the cascade. Never fails
 * the caller; a chunk that cannot be removed must not keep an upload alive.
 */
async function dropChunkFiles(uploadIds: string[]): Promise<number> {
  if (!uploadIds.length) return 0;
  const rows = await getDb()
    .select({ tenantId: datasetUploadChunks.tenantId, storageRef: datasetUploadChunks.storageRef })
    .from(datasetUploadChunks)
    .where(inArray(datasetUploadChunks.uploadId, uploadIds));
  for (const row of rows) await removeFile(row.tenantId, UPLOAD_CHUNK_BUCKET, row.storageRef).catch(() => undefined);
  return rows.length;
}

/**
 * Uploads nobody came back for: the browser was closed, the operator went home.
 * Run by the `gym-cleanup-dataset-uploads` cron job. It also clears the
 * scratch directory of assemblies that were interrupted, and of the chunk
 * directories older installations wrote there.
 */
export async function cleanupStaleUploads(): Promise<{ uploads: number; chunks: number; scratch: number }> {
  const cutoff = new Date(Date.now() - STALE_AFTER_HOURS * 3600 * 1000).toISOString();
  const stale = await getDb().select({ id: datasetUploads.id }).from(datasetUploads).where(lt(datasetUploads.updatedAt, cutoff));
  const ids = stale.map((r) => r.id);
  // the bytes first: the rows are the only record of where they lie, and the
  // delete takes them with the upload through the cascade
  const chunks = await dropChunkFiles(ids);
  if (ids.length) await getDb().delete(datasetUploads).where(inArray(datasetUploads.id, ids));

  const alive = new Set((await getDb().select({ id: datasetUploads.id }).from(datasetUploads)).map((r) => r.id));
  let names: string[] = [];
  try {
    names = await fs.readdir(scratchDir());
  } catch {
    names = [];
  }
  let scratch = 0;
  for (const name of names) {
    if (alive.has(name.replace(/\.zip$/, ""))) continue;
    await fs.rm(`${scratchDir()}/${name}`, { recursive: true, force: true }).catch(() => undefined);
    scratch++;
  }
  if (stale.length || scratch) {
    log.info(`gym: cleaned up ${stale.length} abandoned dataset upload(s) with ${chunks} chunk(s) and ${scratch} leftover scratch entry/entries`);
  }
  return { uploads: stale.length, chunks, scratch };
}

/** The open uploads of a block, so the wizard can offer to resume or to drop them. */
export async function listUploads(tenantId: string, blockId: string): Promise<DatasetUploadView[]> {
  const rows = await getDb()
    .select()
    .from(datasetUploads)
    .where(and(eq(datasetUploads.tenantId, tenantId), eq(datasetUploads.blockId, blockId)));
  if (!rows.length) return [];
  // one query for every chunk of every upload of the block, not one per upload
  const chunks = await getDb()
    .select({ uploadId: datasetUploadChunks.uploadId, index: datasetUploadChunks.index })
    .from(datasetUploadChunks)
    .where(inArray(datasetUploadChunks.uploadId, rows.map((r) => r.id)))
    .orderBy(asc(datasetUploadChunks.index));
  const byUpload = new Map<string, number[]>();
  for (const chunk of chunks) byUpload.set(chunk.uploadId, [...(byUpload.get(chunk.uploadId) ?? []), chunk.index]);
  return rows.map((row) => toView(row, byUpload.get(row.id) ?? []));
}
