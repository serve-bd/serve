ALTER TABLE "backup" ADD COLUMN "s3_status" text;--> statement-breakpoint
ALTER TABLE "backup" ADD COLUMN "restore_status" text;--> statement-breakpoint
ALTER TABLE "backup" ADD COLUMN "restored_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "backup" ADD COLUMN "log" text;