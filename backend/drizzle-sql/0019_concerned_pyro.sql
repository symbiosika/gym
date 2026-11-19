CREATE TABLE "gym_critics_specs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"spec" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "gym_datasets" ADD COLUMN "report_html_ref" text;--> statement-breakpoint
ALTER TABLE "gym_critics_specs" ADD CONSTRAINT "gym_critics_specs_tenant_id_base_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."base_tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "gym_critics_specs_name_uq" ON "gym_critics_specs" USING btree ("tenant_id","name");