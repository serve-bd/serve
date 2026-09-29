ALTER TABLE "api_token" ADD COLUMN "scopes" text[] DEFAULT '{read,deploy}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "api_token" ADD COLUMN "project_ids" text[];--> statement-breakpoint
ALTER TABLE "api_token" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "api_token" ADD COLUMN "last_used_ip" text;