ALTER TABLE "gym_episodes" ADD COLUMN "prompt_override" text;--> statement-breakpoint
ALTER TABLE "gym_skills" ADD COLUMN "prompt_variants" jsonb DEFAULT '{}'::jsonb NOT NULL;