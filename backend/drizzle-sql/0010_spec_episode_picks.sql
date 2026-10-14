ALTER TABLE "gym_spec_drafts" ADD COLUMN "episode_selection" text DEFAULT '0-9' NOT NULL;--> statement-breakpoint
ALTER TABLE "gym_spec_drafts" ADD COLUMN "test_runs" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "gym_spec_drafts" ADD COLUMN "test_specs" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
UPDATE "gym_spec_drafts" SET "episode_selection" = CASE WHEN "sample_size" > 1 THEN '0-' || ("sample_size" - 1)::text ELSE '0' END;--> statement-breakpoint
ALTER TABLE "gym_spec_drafts" DROP COLUMN "sample_size";--> statement-breakpoint
ALTER TABLE "gym_spec_drafts" DROP COLUMN "test_job_id";--> statement-breakpoint
ALTER TABLE "gym_spec_drafts" DROP COLUMN "test_status";--> statement-breakpoint
ALTER TABLE "gym_spec_drafts" DROP COLUMN "test_error";