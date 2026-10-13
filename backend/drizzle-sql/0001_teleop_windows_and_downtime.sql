ALTER TABLE "gym_day_protocols" ADD COLUMN "teleop_intervals" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "gym_day_protocols" ADD COLUMN "downtime" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
-- Days recorded before the windows existed keep their one span: the first
-- start of the day to the last close. Their figure does not change, it just
-- stops growing with every reopen from here on.
UPDATE "gym_day_protocols"
   SET "teleop_intervals" = jsonb_build_array(
         jsonb_build_object(
           'startedAt', to_char("teleop_started_at", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
           'endedAt',   CASE WHEN "teleop_ended_at" IS NULL THEN NULL
                             ELSE to_jsonb(to_char("teleop_ended_at", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) END
         )
       )
 WHERE "teleop_started_at" IS NOT NULL
   AND "teleop_intervals" = '[]'::jsonb;
