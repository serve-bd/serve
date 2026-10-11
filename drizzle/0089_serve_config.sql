ALTER TABLE "scheduled_task" ADD COLUMN "from_file" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "service" ADD COLUMN "config_file" jsonb;