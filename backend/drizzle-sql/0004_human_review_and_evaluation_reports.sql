CREATE TABLE "gym_evaluation_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"skill_id" uuid NOT NULL,
	"name" text NOT NULL,
	"block_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"sections" jsonb DEFAULT '{"prompt":"","successCriteria":"","design":"","reset":"","caveats":"","working":"","needsReview":"","nextSteps":""}'::jsonb NOT NULL,
	"share_id" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "gym_episodes" ADD COLUMN "human_verdict" text;--> statement-breakpoint
ALTER TABLE "gym_episodes" ADD COLUMN "failure_code" text;--> statement-breakpoint
ALTER TABLE "gym_episodes" ADD COLUMN "review_note" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "gym_episodes" ADD COLUMN "variation_label" text;--> statement-breakpoint
ALTER TABLE "gym_episodes" ADD COLUMN "reviewed_by" uuid;--> statement-breakpoint
ALTER TABLE "gym_episodes" ADD COLUMN "reviewed_by_name" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "gym_episodes" ADD COLUMN "reviewed_at" timestamp;--> statement-breakpoint
ALTER TABLE "gym_evaluation_reports" ADD CONSTRAINT "gym_evaluation_reports_tenant_id_base_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."base_tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gym_evaluation_reports" ADD CONSTRAINT "gym_evaluation_reports_skill_id_gym_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."gym_skills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "gym_evaluation_reports_tenant_idx" ON "gym_evaluation_reports" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "gym_evaluation_reports_skill_idx" ON "gym_evaluation_reports" USING btree ("skill_id");--> statement-breakpoint
CREATE UNIQUE INDEX "gym_evaluation_reports_share_uq" ON "gym_evaluation_reports" USING btree ("share_id");