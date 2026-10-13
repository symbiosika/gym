ALTER TABLE "gym_dataset_uploads" ALTER COLUMN "bytes" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "gym_datasets" ALTER COLUMN "bytes" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "gym_datasets" ADD COLUMN "storage_parts" jsonb;