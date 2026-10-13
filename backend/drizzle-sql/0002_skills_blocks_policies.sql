-- Skills, policies and blocks replace sessions.
-- Every session becomes a skill (same id); every day protocol keeps its row as
-- the cell's controlling record and gets one recording block (same id as the
-- day) that carries what the wizard used to store on the day. Datasets,
-- episodes, exports and the audit log follow their session to the skill and
-- their day to the block.
CREATE TABLE "gym_blocks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"day_protocol_id" uuid NOT NULL,
	"skill_id" uuid NOT NULL,
	"kind" text DEFAULT 'recording' NOT NULL,
	"policy_id" uuid,
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
	"teleop_intervals" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"access_token" text,
	"access_token_expires_at" timestamp,
	"created_by" uuid,
	"closed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gym_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"skill_id" uuid NOT NULL,
	"name" text NOT NULL,
	"export_id" uuid,
	"notes" text DEFAULT '' NOT NULL,
	"trained_at" timestamp,
	"created_by" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gym_skills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"collection_id" uuid,
	"name" text NOT NULL,
	"task_description" text DEFAULT '' NOT NULL,
	"critic_spec_name" text,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
INSERT INTO "gym_skills" ("id", "tenant_id", "collection_id", "name", "task_description", "critic_spec_name", "status", "created_by", "created_at", "updated_at")
SELECT "id", "tenant_id", "collection_id", "name", "task_description", "critic_spec_name",
       CASE "status" WHEN 'closed' THEN 'archived' ELSE 'active' END, "created_by", "created_at", "updated_at"
  FROM "gym_sessions";
--> statement-breakpoint
INSERT INTO "gym_blocks" ("id", "tenant_id", "day_protocol_id", "skill_id", "kind", "step", "target_episodes", "scene_image_file_id", "scene_text",
                          "scene_captured_at", "plan", "progress", "follow_up", "teleop_started_at", "teleop_ended_at", "teleop_intervals",
                          "access_token", "access_token_expires_at", "created_by", "closed_at", "created_at", "updated_at")
SELECT "id", "tenant_id", "id", "session_id", 'recording', "step", "target_episodes", "scene_image_file_id", "scene_text",
       "scene_captured_at", "plan", "progress", "follow_up", "teleop_started_at", "teleop_ended_at", "teleop_intervals",
       "access_token", "access_token_expires_at", "operator_user_id", "closed_at", "created_at", "updated_at"
  FROM "gym_day_protocols";
--> statement-breakpoint
ALTER TABLE "gym_audit_log" ADD COLUMN "skill_id" uuid;
--> statement-breakpoint
ALTER TABLE "gym_audit_log" ADD COLUMN "block_id" uuid;
--> statement-breakpoint
ALTER TABLE "gym_datasets" ADD COLUMN "skill_id" uuid;
--> statement-breakpoint
ALTER TABLE "gym_datasets" ADD COLUMN "block_id" uuid;
--> statement-breakpoint
ALTER TABLE "gym_episodes" ADD COLUMN "skill_id" uuid;
--> statement-breakpoint
ALTER TABLE "gym_exports" ADD COLUMN "skill_id" uuid;
--> statement-breakpoint
UPDATE "gym_audit_log" SET "skill_id" = "session_id", "block_id" = "day_protocol_id";
--> statement-breakpoint
UPDATE "gym_datasets" SET "skill_id" = "session_id", "block_id" = "day_protocol_id";
--> statement-breakpoint
UPDATE "gym_episodes" SET "skill_id" = "session_id";
--> statement-breakpoint
UPDATE "gym_exports" SET "skill_id" = "session_id";
--> statement-breakpoint
ALTER TABLE "gym_datasets" ALTER COLUMN "skill_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "gym_datasets" ALTER COLUMN "block_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "gym_episodes" ALTER COLUMN "skill_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "gym_exports" ALTER COLUMN "skill_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "gym_audit_log" DROP CONSTRAINT "gym_audit_log_session_id_gym_sessions_id_fk";
--> statement-breakpoint
ALTER TABLE "gym_audit_log" DROP CONSTRAINT "gym_audit_log_day_protocol_id_gym_day_protocols_id_fk";
--> statement-breakpoint
ALTER TABLE "gym_datasets" DROP CONSTRAINT "gym_datasets_session_id_gym_sessions_id_fk";
--> statement-breakpoint
ALTER TABLE "gym_day_protocols" DROP CONSTRAINT "gym_day_protocols_session_id_gym_sessions_id_fk";
--> statement-breakpoint
ALTER TABLE "gym_episodes" DROP CONSTRAINT "gym_episodes_session_id_gym_sessions_id_fk";
--> statement-breakpoint
ALTER TABLE "gym_exports" DROP CONSTRAINT "gym_exports_session_id_gym_sessions_id_fk";
--> statement-breakpoint
DROP INDEX "gym_audit_log_session_idx";
--> statement-breakpoint
DROP INDEX "gym_datasets_session_idx";
--> statement-breakpoint
DROP INDEX "gym_day_protocols_session_idx";
--> statement-breakpoint
DROP INDEX "gym_day_protocols_token_uq";
--> statement-breakpoint
DROP INDEX "gym_episodes_session_idx";
--> statement-breakpoint
DROP INDEX "gym_exports_session_idx";
--> statement-breakpoint
ALTER TABLE "gym_sessions" DISABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP TABLE "gym_sessions" CASCADE;
--> statement-breakpoint
ALTER TABLE "gym_audit_log" DROP COLUMN "session_id";
--> statement-breakpoint
ALTER TABLE "gym_datasets" DROP COLUMN "session_id";
--> statement-breakpoint
ALTER TABLE "gym_day_protocols" DROP COLUMN "session_id";
--> statement-breakpoint
ALTER TABLE "gym_day_protocols" DROP COLUMN "step";
--> statement-breakpoint
ALTER TABLE "gym_day_protocols" DROP COLUMN "target_episodes";
--> statement-breakpoint
ALTER TABLE "gym_day_protocols" DROP COLUMN "scene_image_file_id";
--> statement-breakpoint
ALTER TABLE "gym_day_protocols" DROP COLUMN "scene_text";
--> statement-breakpoint
ALTER TABLE "gym_day_protocols" DROP COLUMN "scene_captured_at";
--> statement-breakpoint
ALTER TABLE "gym_day_protocols" DROP COLUMN "plan";
--> statement-breakpoint
ALTER TABLE "gym_day_protocols" DROP COLUMN "progress";
--> statement-breakpoint
ALTER TABLE "gym_day_protocols" DROP COLUMN "follow_up";
--> statement-breakpoint
ALTER TABLE "gym_day_protocols" DROP COLUMN "teleop_started_at";
--> statement-breakpoint
ALTER TABLE "gym_day_protocols" DROP COLUMN "teleop_ended_at";
--> statement-breakpoint
ALTER TABLE "gym_day_protocols" DROP COLUMN "teleop_intervals";
--> statement-breakpoint
ALTER TABLE "gym_day_protocols" DROP COLUMN "access_token";
--> statement-breakpoint
ALTER TABLE "gym_day_protocols" DROP COLUMN "access_token_expires_at";
--> statement-breakpoint
ALTER TABLE "gym_episodes" DROP COLUMN "session_id";
--> statement-breakpoint
ALTER TABLE "gym_exports" DROP COLUMN "session_id";
--> statement-breakpoint
ALTER TABLE "gym_blocks" ADD CONSTRAINT "gym_blocks_tenant_id_base_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."base_tenants"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "gym_blocks" ADD CONSTRAINT "gym_blocks_day_protocol_id_gym_day_protocols_id_fk" FOREIGN KEY ("day_protocol_id") REFERENCES "public"."gym_day_protocols"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "gym_blocks" ADD CONSTRAINT "gym_blocks_skill_id_gym_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."gym_skills"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "gym_blocks" ADD CONSTRAINT "gym_blocks_policy_id_gym_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."gym_policies"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "gym_policies" ADD CONSTRAINT "gym_policies_tenant_id_base_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."base_tenants"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "gym_policies" ADD CONSTRAINT "gym_policies_skill_id_gym_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."gym_skills"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "gym_skills" ADD CONSTRAINT "gym_skills_tenant_id_base_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."base_tenants"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "gym_skills" ADD CONSTRAINT "gym_skills_collection_id_gym_collections_id_fk" FOREIGN KEY ("collection_id") REFERENCES "public"."gym_collections"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "gym_blocks_tenant_idx" ON "gym_blocks" USING btree ("tenant_id");
--> statement-breakpoint
CREATE INDEX "gym_blocks_day_idx" ON "gym_blocks" USING btree ("day_protocol_id");
--> statement-breakpoint
CREATE INDEX "gym_blocks_skill_idx" ON "gym_blocks" USING btree ("skill_id","kind");
--> statement-breakpoint
CREATE UNIQUE INDEX "gym_blocks_token_uq" ON "gym_blocks" USING btree ("access_token");
--> statement-breakpoint
CREATE INDEX "gym_policies_tenant_idx" ON "gym_policies" USING btree ("tenant_id");
--> statement-breakpoint
CREATE INDEX "gym_policies_skill_idx" ON "gym_policies" USING btree ("skill_id");
--> statement-breakpoint
CREATE INDEX "gym_skills_tenant_idx" ON "gym_skills" USING btree ("tenant_id");
--> statement-breakpoint
CREATE INDEX "gym_skills_collection_idx" ON "gym_skills" USING btree ("collection_id");
--> statement-breakpoint
CREATE INDEX "gym_skills_status_idx" ON "gym_skills" USING btree ("tenant_id","status");
--> statement-breakpoint
ALTER TABLE "gym_audit_log" ADD CONSTRAINT "gym_audit_log_skill_id_gym_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."gym_skills"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "gym_audit_log" ADD CONSTRAINT "gym_audit_log_block_id_gym_blocks_id_fk" FOREIGN KEY ("block_id") REFERENCES "public"."gym_blocks"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "gym_audit_log" ADD CONSTRAINT "gym_audit_log_day_protocol_id_gym_day_protocols_id_fk" FOREIGN KEY ("day_protocol_id") REFERENCES "public"."gym_day_protocols"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "gym_datasets" ADD CONSTRAINT "gym_datasets_skill_id_gym_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."gym_skills"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "gym_datasets" ADD CONSTRAINT "gym_datasets_block_id_gym_blocks_id_fk" FOREIGN KEY ("block_id") REFERENCES "public"."gym_blocks"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "gym_episodes" ADD CONSTRAINT "gym_episodes_skill_id_gym_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."gym_skills"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "gym_exports" ADD CONSTRAINT "gym_exports_skill_id_gym_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."gym_skills"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "gym_audit_log_skill_idx" ON "gym_audit_log" USING btree ("skill_id","created_at");
--> statement-breakpoint
CREATE INDEX "gym_audit_log_day_idx" ON "gym_audit_log" USING btree ("day_protocol_id","created_at");
--> statement-breakpoint
CREATE INDEX "gym_datasets_skill_idx" ON "gym_datasets" USING btree ("skill_id");
--> statement-breakpoint
CREATE INDEX "gym_datasets_block_idx" ON "gym_datasets" USING btree ("block_id");
--> statement-breakpoint
CREATE INDEX "gym_episodes_skill_idx" ON "gym_episodes" USING btree ("skill_id");
--> statement-breakpoint
CREATE INDEX "gym_exports_skill_idx" ON "gym_exports" USING btree ("skill_id");
