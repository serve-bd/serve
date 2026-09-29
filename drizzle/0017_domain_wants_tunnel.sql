ALTER TABLE "domain" ADD COLUMN "wants_tunnel" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "domain" ADD COLUMN "tunnel_error" text;--> statement-breakpoint
UPDATE "domain" SET "wants_tunnel" = true WHERE "tunnel_id" IS NOT NULL;
