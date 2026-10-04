ALTER TABLE "cloudflare_account" ADD COLUMN "auth_type" text DEFAULT 'token' NOT NULL;--> statement-breakpoint
ALTER TABLE "cloudflare_account" ADD COLUMN "refresh_token" text;--> statement-breakpoint
ALTER TABLE "cloudflare_account" ADD COLUMN "token_expires_at" timestamp with time zone;