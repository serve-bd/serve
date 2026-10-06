ALTER TABLE "backup" ADD COLUMN "verify_status" text;--> statement-breakpoint
ALTER TABLE "backup" ADD COLUMN "verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "backup" ADD COLUMN "verify_detail" text;--> statement-breakpoint
ALTER TABLE "backup" ADD COLUMN "verify_error" text;