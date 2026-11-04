ALTER TABLE "gym_dataset_uploads" ADD COLUMN "spec_overrides" jsonb;--> statement-breakpoint
ALTER TABLE "gym_datasets" ADD COLUMN "spec_overrides" jsonb;