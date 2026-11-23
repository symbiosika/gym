ALTER TABLE "gym_datasets" ADD COLUMN "analysis_pass" text DEFAULT 'full' NOT NULL;--> statement-breakpoint
ALTER TABLE "gym_datasets" ADD COLUMN "analysed_prompts" jsonb;