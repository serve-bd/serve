ALTER TABLE "log_drain" ADD COLUMN "service_ids" text[];--> statement-breakpoint
ALTER TABLE "log_drain" ADD COLUMN "options" jsonb;