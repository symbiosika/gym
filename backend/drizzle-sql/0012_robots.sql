CREATE TABLE "gym_robots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"technical_name" text NOT NULL,
	"personal_name" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'in_service' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"image_ref" text,
	"platform" jsonb DEFAULT '{"manufacturer":"","model":"","serialNumber":"","firmware":""}'::jsonb NOT NULL,
	"capabilities" jsonb DEFAULT '{"sensors":[],"actuators":[],"locomotion":[],"compute":[],"communication":[]}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "gym_audit_log" ADD COLUMN "robot_id" uuid;--> statement-breakpoint
ALTER TABLE "gym_cells" ADD COLUMN "robot_id" uuid;--> statement-breakpoint
ALTER TABLE "gym_cells" ADD COLUMN "no_robot" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "gym_robots" ADD CONSTRAINT "gym_robots_tenant_id_base_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."base_tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "gym_robots_tenant_idx" ON "gym_robots" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "gym_robots_technical_name_uq" ON "gym_robots" USING btree ("tenant_id","technical_name");--> statement-breakpoint
ALTER TABLE "gym_audit_log" ADD CONSTRAINT "gym_audit_log_robot_id_gym_robots_id_fk" FOREIGN KEY ("robot_id") REFERENCES "public"."gym_robots"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gym_cells" ADD CONSTRAINT "gym_cells_robot_id_gym_robots_id_fk" FOREIGN KEY ("robot_id") REFERENCES "public"."gym_robots"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "gym_audit_log_robot_idx" ON "gym_audit_log" USING btree ("robot_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "gym_cells_robot_uq" ON "gym_cells" USING btree ("robot_id");--> statement-breakpoint
-- Every free-text robot of a cell becomes a robot of its own, placed in that
-- cell. The robot borrows the cell's id, which ties the two together without
-- a lookup table; two cells naming the same robot get it twice, told apart by
-- the cell, since a robot is in one cell at most.
INSERT INTO "gym_robots" ("id", "tenant_id", "technical_name")
SELECT "id", "tenant_id",
  CASE WHEN count(*) OVER (PARTITION BY "tenant_id", trim("robot")) > 1
    THEN trim("robot") || ' (' || "name" || ')'
    ELSE trim("robot") END
FROM "gym_cells" WHERE trim("robot") <> '';--> statement-breakpoint
UPDATE "gym_cells" SET "robot_id" = "id" WHERE trim("robot") <> '';
