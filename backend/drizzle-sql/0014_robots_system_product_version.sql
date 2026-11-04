ALTER TABLE "gym_robots" ALTER COLUMN "platform" SET DEFAULT '{"manufacturer":"","model":"","serialNumber":"","productVersion":""}'::jsonb;--> statement-breakpoint
ALTER TABLE "gym_robots" ALTER COLUMN "capabilities" SET DEFAULT '{"sensors":[],"actuators":[],"locomotion":[],"compute":[],"communication":[],"system":[]}'::jsonb;--> statement-breakpoint
-- The platform's firmware became its product version: carry the value over.
UPDATE "gym_robots"
SET "platform" = ("platform" - 'firmware') || jsonb_build_object('productVersion', coalesce("platform"->>'productVersion', "platform"->>'firmware', ''))
WHERE "platform" ? 'firmware';--> statement-breakpoint
-- Every robot gets the new, empty system section.
UPDATE "gym_robots"
SET "capabilities" = "capabilities" || '{"system":[]}'::jsonb
WHERE NOT ("capabilities" ? 'system');
