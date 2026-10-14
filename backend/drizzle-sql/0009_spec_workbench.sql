ALTER TABLE "gym_spec_drafts" ADD COLUMN "extra_episodes" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "gym_spec_drafts" ADD COLUMN "extra_runs" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "gym_spec_drafts" ADD COLUMN "judgments" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
UPDATE "gym_spec_drafts" SET "step" = 'workbench' WHERE "step" IN ('checks', 'success', 'scoring');
