-- Tables of the previous GYM data model keep their data in the gym_legacy
-- schema; the new model below is created from scratch in public.
CREATE SCHEMA IF NOT EXISTS "gym_legacy";--> statement-breakpoint
ALTER TABLE IF EXISTS "public"."gym_episodes" SET SCHEMA "gym_legacy";--> statement-breakpoint
ALTER TABLE IF EXISTS "public"."gym_imports" SET SCHEMA "gym_legacy";--> statement-breakpoint
ALTER TABLE IF EXISTS "public"."gym_tasks" SET SCHEMA "gym_legacy";--> statement-breakpoint
ALTER TABLE IF EXISTS "public"."gym_protocols" SET SCHEMA "gym_legacy";--> statement-breakpoint
ALTER TABLE IF EXISTS "public"."gym_protocol_templates" SET SCHEMA "gym_legacy";--> statement-breakpoint
ALTER TABLE IF EXISTS "public"."gym_master_data" SET SCHEMA "gym_legacy";--> statement-breakpoint
ALTER TABLE IF EXISTS "public"."gym_master_data_items" SET SCHEMA "gym_legacy";--> statement-breakpoint
ALTER TABLE IF EXISTS "public"."gym_team_permissions" SET SCHEMA "gym_legacy";--> statement-breakpoint
ALTER TABLE IF EXISTS "public"."gym_collections" SET SCHEMA "gym_legacy";--> statement-breakpoint
CREATE TABLE "gym_audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"day_protocol_id" uuid,
	"user_id" uuid,
	"user_name" text DEFAULT '' NOT NULL,
	"action" text NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gym_cells" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"location" text DEFAULT '' NOT NULL,
	"robot" text DEFAULT '' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gym_collections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"customer" text DEFAULT '' NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gym_datasets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"day_protocol_id" uuid NOT NULL,
	"name" text NOT NULL,
	"source_file_name" text DEFAULT '' NOT NULL,
	"bytes" integer DEFAULT 0 NOT NULL,
	"episode_count" integer DEFAULT 0 NOT NULL,
	"critics_dataset_name" text NOT NULL,
	"critics_job_id" text,
	"critic_spec_name" text,
	"analysis_status" text DEFAULT 'queued' NOT NULL,
	"progress" jsonb,
	"analysis" jsonb,
	"report" jsonb,
	"selection" jsonb,
	"analysis_error" text,
	"uploaded_by" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gym_day_protocols" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"cell_id" uuid NOT NULL,
	"date" text NOT NULL,
	"operator_user_id" uuid,
	"operator_name" text DEFAULT '' NOT NULL,
	"step" text DEFAULT 'brief' NOT NULL,
	"target_episodes" integer,
	"scene_image_file_id" uuid,
	"scene_text" text DEFAULT '' NOT NULL,
	"scene_captured_at" timestamp,
	"plan" jsonb,
	"progress" jsonb,
	"follow_up" jsonb,
	"teleop_started_at" timestamp,
	"teleop_ended_at" timestamp,
	"notes" text DEFAULT '' NOT NULL,
	"access_token" text,
	"access_token_expires_at" timestamp,
	"share_id" text NOT NULL,
	"closed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gym_episodes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"dataset_id" uuid NOT NULL,
	"index" integer NOT NULL,
	"task" text DEFAULT '' NOT NULL,
	"frames" integer,
	"duration_seconds" real,
	"verdict" text DEFAULT 'unknown' NOT NULL,
	"total_score" real,
	"hard_score" real,
	"soft_score" real,
	"flags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"reason" jsonb,
	"critic_scores" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error" text,
	"selected" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gym_exports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"name" text NOT NULL,
	"selection" jsonb NOT NULL,
	"created_by" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gym_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"cell_id" uuid NOT NULL,
	"collection_id" uuid,
	"name" text NOT NULL,
	"task_description" text DEFAULT '' NOT NULL,
	"critic_spec_name" text,
	"status" text DEFAULT 'active' NOT NULL,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"closed_at" timestamp,
	"created_by" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "gym_audit_log" ADD CONSTRAINT "gym_audit_log_tenant_id_base_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."base_tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gym_audit_log" ADD CONSTRAINT "gym_audit_log_session_id_gym_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."gym_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gym_audit_log" ADD CONSTRAINT "gym_audit_log_day_protocol_id_gym_day_protocols_id_fk" FOREIGN KEY ("day_protocol_id") REFERENCES "public"."gym_day_protocols"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gym_cells" ADD CONSTRAINT "gym_cells_tenant_id_base_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."base_tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gym_collections" ADD CONSTRAINT "gym_collections_tenant_id_base_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."base_tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gym_datasets" ADD CONSTRAINT "gym_datasets_tenant_id_base_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."base_tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gym_datasets" ADD CONSTRAINT "gym_datasets_session_id_gym_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."gym_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gym_datasets" ADD CONSTRAINT "gym_datasets_day_protocol_id_gym_day_protocols_id_fk" FOREIGN KEY ("day_protocol_id") REFERENCES "public"."gym_day_protocols"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gym_day_protocols" ADD CONSTRAINT "gym_day_protocols_tenant_id_base_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."base_tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gym_day_protocols" ADD CONSTRAINT "gym_day_protocols_session_id_gym_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."gym_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gym_day_protocols" ADD CONSTRAINT "gym_day_protocols_cell_id_gym_cells_id_fk" FOREIGN KEY ("cell_id") REFERENCES "public"."gym_cells"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gym_episodes" ADD CONSTRAINT "gym_episodes_tenant_id_base_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."base_tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gym_episodes" ADD CONSTRAINT "gym_episodes_session_id_gym_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."gym_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gym_episodes" ADD CONSTRAINT "gym_episodes_dataset_id_gym_datasets_id_fk" FOREIGN KEY ("dataset_id") REFERENCES "public"."gym_datasets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gym_exports" ADD CONSTRAINT "gym_exports_tenant_id_base_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."base_tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gym_exports" ADD CONSTRAINT "gym_exports_session_id_gym_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."gym_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gym_sessions" ADD CONSTRAINT "gym_sessions_tenant_id_base_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."base_tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gym_sessions" ADD CONSTRAINT "gym_sessions_cell_id_gym_cells_id_fk" FOREIGN KEY ("cell_id") REFERENCES "public"."gym_cells"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gym_sessions" ADD CONSTRAINT "gym_sessions_collection_id_gym_collections_id_fk" FOREIGN KEY ("collection_id") REFERENCES "public"."gym_collections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "gym_audit_log_tenant_idx" ON "gym_audit_log" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "gym_audit_log_session_idx" ON "gym_audit_log" USING btree ("session_id","created_at");--> statement-breakpoint
CREATE INDEX "gym_cells_tenant_idx" ON "gym_cells" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "gym_cells_name_uq" ON "gym_cells" USING btree ("tenant_id","name");--> statement-breakpoint
CREATE INDEX "gym_collections_tenant_idx" ON "gym_collections" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "gym_collections_name_uq" ON "gym_collections" USING btree ("tenant_id","name");--> statement-breakpoint
CREATE INDEX "gym_datasets_tenant_idx" ON "gym_datasets" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "gym_datasets_session_idx" ON "gym_datasets" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "gym_datasets_day_idx" ON "gym_datasets" USING btree ("day_protocol_id");--> statement-breakpoint
CREATE INDEX "gym_datasets_status_idx" ON "gym_datasets" USING btree ("analysis_status");--> statement-breakpoint
CREATE INDEX "gym_day_protocols_tenant_idx" ON "gym_day_protocols" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "gym_day_protocols_session_idx" ON "gym_day_protocols" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "gym_day_protocols_date_idx" ON "gym_day_protocols" USING btree ("tenant_id","date");--> statement-breakpoint
CREATE UNIQUE INDEX "gym_day_protocols_cell_date_uq" ON "gym_day_protocols" USING btree ("tenant_id","cell_id","date");--> statement-breakpoint
CREATE UNIQUE INDEX "gym_day_protocols_share_uq" ON "gym_day_protocols" USING btree ("share_id");--> statement-breakpoint
CREATE UNIQUE INDEX "gym_day_protocols_token_uq" ON "gym_day_protocols" USING btree ("access_token");--> statement-breakpoint
CREATE INDEX "gym_episodes_tenant_idx" ON "gym_episodes" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "gym_episodes_session_idx" ON "gym_episodes" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "gym_episodes_dataset_idx" ON "gym_episodes" USING btree ("dataset_id");--> statement-breakpoint
CREATE UNIQUE INDEX "gym_episodes_identity_uq" ON "gym_episodes" USING btree ("dataset_id","index");--> statement-breakpoint
CREATE INDEX "gym_exports_tenant_idx" ON "gym_exports" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "gym_exports_session_idx" ON "gym_exports" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "gym_sessions_tenant_idx" ON "gym_sessions" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "gym_sessions_cell_idx" ON "gym_sessions" USING btree ("cell_id");--> statement-breakpoint
CREATE INDEX "gym_sessions_status_idx" ON "gym_sessions" USING btree ("tenant_id","status");