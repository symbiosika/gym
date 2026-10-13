/**
 * Where the binary data of GYM lives.
 *
 * Everything the app stores as bytes goes through this module: the scene
 * photos and the reference images of a plan (lib/gym/blocks.ts) and the chunks
 * of a resumable dataset upload (lib/gym/dataset-uploads.ts). No other place in
 * the app writes a file, so an installation has one switch and not one per
 * feature, and nothing ends up on a container's local disc by accident.
 *
 * This module is a wrapper, not a storage. It picks the backend from the
 * configuration, keeps the reference a row has to carry and leaves the bytes
 * to the framework: `saveFile`, `getFile` and `deleteFile` of
 * `@framework/lib/storage` do the work, every time, for every driver. The app
 * implements no backend of its own and never will; a backend GYM needs belongs
 * in the framework, where every Symbiosika app gets it.
 *
 * Configuration, one variable:
 *
 *   GYM_STORAGE_DRIVER=db     the database, the default: nothing to set up,
 *                             the data is in the backup of the database
 *   GYM_STORAGE_DRIVER=local  the disc of the container, for development.
 *                             Not for a deployment with more than one replica
 *                             or with a container that is replaced.
 *   GYM_STORAGE_DRIVER=s3     an S3-compatible object store (AWS, MinIO, Ceph,
 *                             Cloudflare R2, Hetzner, Scaleway): keeps large
 *                             data out of the database and is reached by every
 *                             replica. Needs S3_BUCKET and, unless the runtime
 *                             provides them, S3_ACCESS_KEY_ID and
 *                             S3_SECRET_ACCESS_KEY; S3_ENDPOINT for anything
 *                             that is not AWS, S3_REGION, S3_PREFIX,
 *                             S3_VIRTUAL_HOSTED_STYLE. The framework reads
 *                             those and owns the backend; GYM only names it.
 *
 * ## The reference
 *
 * A stored file is addressed by a `StorageRef`, `"<driver>:<name>"`, and that
 * is what the rows carry (`blocks.scene_image_ref`, the `ref` of a plan
 * variation, `dataset_upload_chunks.storage_ref`). The driver travels with the
 * file, so switching the variable keeps everything that was written before
 * readable and only sends new files elsewhere. A reference without a driver is
 * a file from before this module and lies in the database.
 */
import { deleteFile, getFile, saveFile } from "@framework/lib/storage";
import { assertS3Configured } from "@framework/lib/storage/s3";
import { shareFile as shareFrameworkFile, type SharedFile } from "@framework/lib/storage/share";

/**
 * The names GYM accepts for a backend, which are the framework's own. Listing
 * them catches a typo in the configuration at start-up instead of on the first
 * photo of the day.
 */
export const STORAGE_DRIVERS = ["db", "local", "s3"] as const;
export type StorageDriver = (typeof STORAGE_DRIVERS)[number];

/** The drivers the framework can actually serve. Grows with the framework, not with this app. */
const FRAMEWORK_DRIVERS = ["db", "local", "s3"] as const;
type FrameworkDriver = (typeof FRAMEWORK_DRIVERS)[number];

/** Where new files go. Anything unknown is refused rather than silently written to the database. */
export function storageDriver(): StorageDriver {
  const configured = (process.env.GYM_STORAGE_DRIVER ?? "").trim().toLowerCase();
  if (!configured) return "db";
  if ((STORAGE_DRIVERS as readonly string[]).includes(configured)) return configured as StorageDriver;
  throw new Error(`GYM_STORAGE_DRIVER=${configured} is not a storage driver; use one of ${STORAGE_DRIVERS.join(", ")}`);
}

/**
 * The driver to hand to the framework, or an error naming what is missing.
 * Keeping this in one place is what makes a new framework backend a one-line
 * change here and no change anywhere else in the app.
 */
function frameworkDriver(driver: StorageDriver): FrameworkDriver {
  if ((FRAMEWORK_DRIVERS as readonly string[]).includes(driver)) return driver as FrameworkDriver;
  throw new Error(
    `GYM_STORAGE_DRIVER=${driver}: the symbiosika-framework has no ${driver} storage backend yet. ` +
      `GYM stores nothing on its own, so the backend has to be added to the framework (lib/storage). ` +
      `Until then use one of ${FRAMEWORK_DRIVERS.join(", ")}.`,
  );
}

/** `"<driver>:<name>"`. Kept as a string because it is stored in columns and in JSON documents. */
export type StorageRef = string;

export interface StoredFile {
  ref: StorageRef;
  driver: StorageDriver;
  /** the name inside the bucket: what the backend was given back */
  name: string;
  /** the name the file had when it was uploaded */
  originalName: string;
  bytes: number;
}

/**
 * Split a reference. A reference without a driver comes from before this
 * module and means the database, so old rows keep working without a migration.
 */
export function parseRef(ref: StorageRef): { driver: StorageDriver; name: string } {
  const separator = ref.indexOf(":");
  if (separator > 0) {
    const driver = ref.slice(0, separator);
    if ((STORAGE_DRIVERS as readonly string[]).includes(driver)) {
      return { driver: driver as StorageDriver, name: ref.slice(separator + 1) };
    }
  }
  return { driver: "db", name: ref };
}

export const buildRef = (driver: StorageDriver, name: string): StorageRef => `${driver}:${name}`;

/**
 * What the backend wants to be given back. The disc keeps the extension in the
 * name, because it is part of the path of the file; the database wants the
 * bare row id, because its delete takes the name as the id and does not strip
 * an extension the way its read does.
 */
const nameOf = (driver: FrameworkDriver, saved: { id: string; path: string }): string =>
  driver === "db" ? saved.id : saved.path.split("/").pop()!;

/** Store a file and return the reference the caller has to keep. */
export async function putFile(tenantId: string, bucket: string, file: File): Promise<StoredFile> {
  const driver = storageDriver();
  const backend = frameworkDriver(driver);
  const saved = await saveFile(file, bucket, tenantId, backend);
  const name = nameOf(backend, saved);
  return { ref: buildRef(driver, name), driver, name, originalName: file.name, bytes: file.size };
}

/** Read a file back. Throws when it is gone, like the framework does. */
export async function readFile(tenantId: string, bucket: string, ref: StorageRef): Promise<File> {
  const { driver, name } = parseRef(ref);
  return getFile(name, bucket, tenantId, frameworkDriver(driver));
}

/** Remove a file. Throws when the framework refuses; the callers that do not care say so with a `.catch`. */
export async function removeFile(tenantId: string, bucket: string, ref: StorageRef): Promise<void> {
  const { driver, name } = parseRef(ref);
  await deleteFile(name, bucket, tenantId, frameworkDriver(driver));
}

/**
 * Hand a stored file to something that is not the app: a temporary URL that
 * carries its own permission and stops working when the time is up. That is
 * how the data critics get a dataset: they are given a link, not the bytes,
 * and they keep nothing (lib/gym/datasets.ts, lib/gym/exports.ts).
 *
 * With an object store the link is presigned and the bytes go straight from
 * the store to the critics, never through this app. With the database or the
 * disc it is a link of this installation, served by the framework. The caller
 * does not have to know which, which is the point.
 */
export async function shareFile(
  tenantId: string,
  bucket: string,
  ref: StorageRef,
  options: { expiresInSeconds?: number } = {},
): Promise<SharedFile> {
  const { driver, name } = parseRef(ref);
  return shareFrameworkFile(name, bucket, tenantId, frameworkDriver(driver), options);
}

export type { SharedFile };

/**
 * Say at start-up what the installation is configured for, and refuse to start
 * on a configuration that cannot work: a driver the framework does not carry,
 * or an object store without a bucket. Both have to be heard on the first
 * boot, not on the first photo an operator takes. What makes an S3
 * configuration complete is the framework's business, so the framework is
 * asked.
 */
export function assertStorageConfigured(): StorageDriver {
  const driver = storageDriver();
  if (frameworkDriver(driver) === "s3") assertS3Configured();
  return driver;
}
