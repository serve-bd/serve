ALTER TABLE "cloudflare_account" ALTER COLUMN "credential_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "cloudflare_account" DROP COLUMN "api_token";--> statement-breakpoint
ALTER TABLE "cloudflare_account" DROP COLUMN "auth_type";--> statement-breakpoint
ALTER TABLE "cloudflare_account" DROP COLUMN "refresh_token";--> statement-breakpoint
ALTER TABLE "cloudflare_account" DROP COLUMN "token_expires_at";--> statement-breakpoint
ALTER TABLE "cloudflare_account" DROP COLUMN "origin_ca_key";