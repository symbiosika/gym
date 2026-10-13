CREATE TABLE "gym_dataset_uploads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"block_id" uuid NOT NULL,
	"file_name" text NOT NULL,
	"display_name" text DEFAULT '' NOT NULL,
	"bytes" integer NOT NULL,
	"chunk_size" integer NOT NULL,
	"chunk_count" integer NOT NULL,
	"created_by" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "gym_dataset_uploads" ADD CONSTRAINT "gym_dataset_uploads_tenant_id_base_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."base_tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gym_dataset_uploads" ADD CONSTRAINT "gym_dataset_uploads_block_id_gym_blocks_id_fk" FOREIGN KEY ("block_id") REFERENCES "public"."gym_blocks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "gym_dataset_uploads_tenant_idx" ON "gym_dataset_uploads" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "gym_dataset_uploads_block_idx" ON "gym_dataset_uploads" USING btree ("block_id");--> statement-breakpoint
CREATE INDEX "gym_dataset_uploads_updated_idx" ON "gym_dataset_uploads" USING btree ("updated_at");