/**
 * The buckets GYM stores bytes in. One file, because two modules share them:
 * a block owns its scene photo and the reference images of its plan
 * (lib/gym/blocks.ts) and the chunks of an upload that is still running
 * (lib/gym/dataset-uploads.ts), and deleting a block has to drop all three
 * without the two modules importing each other.
 *
 * A bucket is a name the framework's storage takes (lib/storage), not a
 * directory and not a bucket of an object store: what a backend makes of it is
 * the backend's business.
 */
export const SCENE_IMAGE_BUCKET = "gym-scene";
export const VARIATION_IMAGE_BUCKET = "gym-variation";
export const UPLOAD_CHUNK_BUCKET = "gym-upload-chunks";
/** the recorded datasets themselves: the zip an operator uploaded, kept for the critics and the export */
export const DATASET_BUCKET = "gym-datasets";
