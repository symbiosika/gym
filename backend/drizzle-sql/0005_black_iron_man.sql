CREATE TABLE "gym_dataset_upload_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"upload_id" uuid NOT NULL,
	"index" integer NOT NULL,
	"storage_ref" text NOT NULL,
	"bytes" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "gym_blocks" ADD COLUMN "scene_image_ref" text;--> statement-breakpoint
ALTER TABLE "gym_dataset_upload_chunks" ADD CONSTRAINT "gym_dataset_upload_chunks_tenant_id_base_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."base_tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gym_dataset_upload_chunks" ADD CONSTRAINT "gym_dataset_upload_chunks_upload_id_gym_dataset_uploads_id_fk" FOREIGN KEY ("upload_id") REFERENCES "public"."gym_dataset_uploads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "gym_dataset_upload_chunks_tenant_idx" ON "gym_dataset_upload_chunks" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "gym_dataset_upload_chunks_upload_index_idx" ON "gym_dataset_upload_chunks" USING btree ("upload_id","index");--> statement-breakpoint
-- the scene photo keeps its file, only the way it is addressed changes: a
-- storage reference ("<driver>:<name>", see backend/src/lib/storage). Every
-- file that exists today lies in the database.
UPDATE "gym_blocks" SET "scene_image_ref" = 'db:' || "scene_image_file_id"::text WHERE "scene_image_file_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "gym_blocks" DROP COLUMN "scene_image_file_id";--> statement-breakpoint
-- the same for the reference images of a plan: plan.steps[].variations[].image
-- carried a "fileId" and now carries a "ref"
UPDATE "gym_blocks" b
SET "plan" = jsonb_set(
  b."plan",
  '{steps}',
  COALESCE((
    SELECT jsonb_agg(
      CASE WHEN jsonb_typeof(step->'variations') = 'array' THEN jsonb_set(
        step,
        '{variations}',
        COALESCE((
          SELECT jsonb_agg(
            CASE WHEN jsonb_typeof(variation->'image') = 'object' AND variation->'image' ? 'fileId'
              THEN jsonb_set(
                variation,
                '{image}',
                ((variation->'image') - 'fileId') || jsonb_build_object('ref', 'db:' || (variation->'image'->>'fileId'))
              )
              ELSE variation
            END
            ORDER BY variation_position
          )
          FROM jsonb_array_elements(step->'variations') WITH ORDINALITY AS v(variation, variation_position)
        ), '[]'::jsonb)
      ) ELSE step END
      ORDER BY step_position
    )
    FROM jsonb_array_elements(b."plan"->'steps') WITH ORDINALITY AS s(step, step_position)
  ), '[]'::jsonb)
)
WHERE b."plan" IS NOT NULL AND jsonb_typeof(b."plan"->'steps') = 'array';