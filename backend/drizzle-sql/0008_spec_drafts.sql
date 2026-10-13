CREATE TABLE "gym_spec_drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"skill_id" uuid,
	"name" text DEFAULT '' NOT NULL,
	"purpose" text DEFAULT 'recording' NOT NULL,
	"step" text DEFAULT 'sample' NOT NULL,
	"sample_size" integer DEFAULT 10 NOT NULL,
	"file_name" text DEFAULT '' NOT NULL,
	"bytes" bigint DEFAULT 0 NOT NULL,
	"storage_parts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"analysis_job_id" text,
	"analysis_status" text DEFAULT 'none' NOT NULL,
	"analysis_error" text,
	"analysis_report" jsonb,
	"spec" jsonb,
	"test_job_id" text,
	"test_status" text DEFAULT 'none' NOT NULL,
	"test_error" text,
	"test_report" jsonb,
	"created_by" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "gym_dataset_uploads" ALTER COLUMN "block_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "gym_dataset_uploads" ADD COLUMN "spec_draft_id" uuid;--> statement-breakpoint
ALTER TABLE "gym_spec_drafts" ADD CONSTRAINT "gym_spec_drafts_tenant_id_base_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."base_tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gym_spec_drafts" ADD CONSTRAINT "gym_spec_drafts_skill_id_gym_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."gym_skills"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "gym_spec_drafts_tenant_idx" ON "gym_spec_drafts" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "gym_spec_drafts_updated_idx" ON "gym_spec_drafts" USING btree ("updated_at");--> statement-breakpoint
ALTER TABLE "gym_dataset_uploads" ADD CONSTRAINT "gym_dataset_uploads_spec_draft_id_gym_spec_drafts_id_fk" FOREIGN KEY ("spec_draft_id") REFERENCES "public"."gym_spec_drafts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "gym_dataset_uploads_spec_draft_idx" ON "gym_dataset_uploads" USING btree ("spec_draft_id");