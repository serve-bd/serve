DROP INDEX "cloudflare_tunnel_server_account_idx";--> statement-breakpoint
ALTER TABLE "cloudflare_tunnel" ADD COLUMN "service_id" text;--> statement-breakpoint
ALTER TABLE "cloudflare_tunnel" ADD CONSTRAINT "cloudflare_tunnel_service_id_service_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."service"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cloudflare_tunnel_service_idx" ON "cloudflare_tunnel" USING btree ("service_id") WHERE "cloudflare_tunnel"."service_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "cloudflare_tunnel_server_account_idx" ON "cloudflare_tunnel" USING btree ("server_id","cloudflare_account_id") WHERE "cloudflare_tunnel"."service_id" is null;