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
 * is completed by whichever replica is asked, and a container that is
 * replaced mid-upload costs nothing.
 *
 * `complete` does not put the zip together. The chunks become the dataset as
 * they are (`datasets.storage_parts`), and the critics are handed one link per
 * chunk and join them on their side (critics/lerobot_critics/api/sources.py).
 * So completing an upload of several gigabytes is one short request that moves
 * no bytes: no archive in the memory of the process, no file on its disc, no
 * single object larger than a chunk in the storage (which the database could
 * not hold: a Postgres value ends at one gigabyte), and nothing a proxy times
 * out on.
 */
import fs from "fs/promises";
import { and, asc, eq, inArray, lt, type SQL } from "drizzle-orm";
import { getDb } from "@framework/lib/db/db-connection";
import log from "@framework/lib/log";
import { datasetUploadChunks, datasetUploads, type DatasetUploadSelect } from "../../db/schema";
import { putFile, removeFile } from "../storage";
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
 * not move megabytes to see the parts come together).
 */
export const DEFAULT_CHUNK_SIZE = 8 * 1024 * 1024;

const chunkSize = (): number => {
  const configured = Number(process.env.GYM_UPLOAD_CHUNK_SIZE);
  return Number.isInteger(configured) && configured > 0 ? configured : DEFAULT_CHUNK_SIZE;
};

/**
 * 50 GB by default. Not a limit of the storage (a dataset is stored in chunks)
 * but a guard against a file picked by mistake; GYM_MAX_UPLOAD_BYTES moves it.
 * The critics need about twice the size of a dataset on their disc while they
 * work on it, the zip and what it unpacks to.
 */
export const DEFAULT_MAX_UPLOAD_BYTES = 50 * 1000 ** 3;

export const maxUploadBytes = (): number => {
  const configured = Number(process.env.GYM_MAX_UPLOAD_BYTES);
  return Number.isSafeInteger(configured) && configured > 0 ? configured : DEFAULT_MAX_UPLOAD_BYTES;
};

/** An upload with no sign of life for this long is abandoned; the cron job clears it. */
const STALE_AFTER_HOURS = 24;

/**
 * Where earlier versions put the zip together before handing it on. Nothing is
 * written there any more; the cleanup still clears what an interrupted
 * assembly of such a version left behind.
 */
const scratchDir = () => `${process.env.TEMPORARY_STORAGE_PATH || "./tmp"}/gym-uploads`;

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

/**
 * Whom an upload is for: a block, whose upload becomes a dataset, or a spec
 * draft, whose upload is the sample the wizard works from (lib/gym/spec-drafts.ts).
 */
export type UploadOwner = { blockId: string } | { specDraftId: string };

const ownerFilter = (owner: UploadOwner): SQL =>
  "blockId" in owner ? eq(datasetUploads.blockId, owner.blockId) : eq(datasetUploads.specDraftId, owner.specDraftId);

/** The upload of this owner, or 404. Tenant-scoped like every other read. */
async function getUploadRow(tenantId: string, owner: UploadOwner, uploadId: string): Promise<DatasetUploadSelect> {
  const rows = await getDb()
    .select()
    .from(datasetUploads)
    .where(and(eq(datasetUploads.id, uploadId), eq(datasetUploads.tenantId, tenantId), ownerFilter(owner)))
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
 * The owner must exist in the tenant; for a block that is checked here, for a
 * spec draft by the caller (lib/gym/spec-drafts.ts).
 */
export async function beginUpload(
  tenantId: string,
  actor: Actor,
  owner: UploadOwner,
  file: { fileName: string; bytes: number; displayName?: string },
): Promise<DatasetUploadView> {
  const ownerColumns = "blockId" in owner ? { blockId: (await getBlockRow(tenantId, owner.blockId)).id } : { specDraftId: owner.specDraftId };
  assertDatasetZip(file.fileName, file.bytes);
  if (file.bytes > maxUploadBytes()) {
    throw new InvalidInputError(`The dataset is larger than ${Math.floor(maxUploadBytes() / 1000 ** 3)} GB; split the recording into several zips`);
  }
  const [row] = await getDb()
    .insert(datasetUploads)
    .values({
      tenantId,
      ...ownerColumns,
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
export async function getUpload(tenantId: string, owner: UploadOwner, uploadId: string): Promise<DatasetUploadView> {
  const row = await getUploadRow(tenantId, owner, uploadId);
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
  owner: UploadOwner,
  uploadId: string,
  index: number,
  data: ArrayBuffer,
): Promise<DatasetUploadView> {
  const row = await getUploadRow(tenantId, owner, uploadId);
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
 * All chunks of an upload are in: check them and claim the upload, so that a
 * completion sent twice (a double click, a retry after a timeout) cannot hand
 * the same chunks to two owners: deleting one would take the bytes of the
 * other. Whoever moves the row on first wins. Returns what was announced and
 * the storage references of the chunks in order; nothing is read or copied.
 *
 * The caller hands the parts on and then calls `releaseUpload`, which drops
 * the record of the upload but not the bytes, which belong to the new owner.
 * If handing on fails the row survives, so the operator can ask for
 * completion again without sending the data a second time.
 */
export async function claimCompletedUpload(
  tenantId: string,
  owner: UploadOwner,
  uploadId: string,
): Promise<{ upload: DatasetUploadSelect; parts: string[] }> {
  const row = await getUploadRow(tenantId, owner, uploadId);
  const chunks = await getDb()
    .select({ index: datasetUploadChunks.index, storageRef: datasetUploadChunks.storageRef, bytes: datasetUploadChunks.bytes })
    .from(datasetUploadChunks)
    .where(eq(datasetUploadChunks.uploadId, uploadId))
    .orderBy(asc(datasetUploadChunks.index));
  if (chunks.length !== row.chunkCount) {
    const received = new Set(chunks.map((c) => c.index));
    const missing = Array.from({ length: row.chunkCount }, (_, i) => i).filter((i) => !received.has(i));
    throw new ConflictError(`The upload is incomplete: ${missing.length} of ${row.chunkCount} chunks are missing (${missing.slice(0, 10).join(", ")})`);
  }
  // every chunk was checked against its expected size when it arrived; this is
  // the last word before the critics see the parts as one archive
  const total = chunks.reduce((sum, c) => sum + c.bytes, 0);
  if (total !== row.bytes) {
    await dropUpload(tenantId, uploadId);
    throw new InvalidInputError(`The chunks add up to ${total} bytes, ${row.bytes} were announced; upload the dataset again`);
  }
  const claimed = await getDb()
    .update(datasetUploads)
    .set({ updatedAt: new Date().toISOString() })
    .where(and(eq(datasetUploads.id, uploadId), eq(datasetUploads.updatedAt, row.updatedAt)))
    .returning({ id: datasetUploads.id });
  if (!claimed.length) throw new ConflictError("The upload is being completed already");
  return { upload: row, parts: chunks.map((c) => c.storageRef) };
}

/**
 * The chunks belong to their new owner now: only the record of the upload goes
 * (the chunk rows with it through the cascade), never the bytes.
 */
export async function releaseUpload(uploadId: string): Promise<void> {
  await getDb().delete(datasetUploads).where(eq(datasetUploads.id, uploadId));
}

/**
 * All chunks are in: the chunks become the dataset and the critics run
 * starts. Nothing is read, copied or put together; the critics are handed a
 * link to each chunk and join them themselves (see the top of this file).
 */
export async function completeUpload(tenantId: string, actor: Actor, blockId: string, uploadId: string): Promise<DatasetView> {
  const { upload: row, parts } = await claimCompletedUpload(tenantId, { blockId }, uploadId);
  const dataset = await createDataset(tenantId, actor, blockId, {
    fileName: row.fileName,
    bytes: row.bytes,
    parts,
    displayName: row.displayName || undefined,
    contentType: "application/zip",
  });
  await releaseUpload(uploadId);
  return dataset;
}

/**
 * The operator removed the file from the list, or gave up: drop the chunks.
 * Not written to the audit log; no dataset ever entered the gym, and the log is
 * about the work of the day, not about a file that was picked and dropped.
 */
export async function abortUpload(tenantId: string, owner: UploadOwner, uploadId: string): Promise<void> {
  await getUploadRow(tenantId, owner, uploadId);
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
export async function dropChunkFiles(uploadIds: string[]): Promise<number> {
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

/** The open uploads of a block or a spec draft, so the wizard can offer to resume or to drop them. */
export async function listUploads(tenantId: string, owner: UploadOwner): Promise<DatasetUploadView[]> {
  const rows = await getDb()
    .select()
    .from(datasetUploads)
    .where(and(eq(datasetUploads.tenantId, tenantId), ownerFilter(owner)));
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
