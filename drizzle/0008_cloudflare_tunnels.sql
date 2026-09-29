CREATE TABLE "cloudflare_tunnel" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"cloudflare_account_id" text NOT NULL,
	"server_id" text NOT NULL,
	"cf_tunnel_id" text NOT NULL,
	"name" text NOT NULL,
	"token" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"status_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "domain" ADD COLUMN "tunnel_id" text;--> statement-breakpoint
ALTER TABLE "cloudflare_tunnel" ADD CONSTRAINT "cloudflare_tunnel_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloudflare_tunnel" ADD CONSTRAINT "cloudflare_tunnel_cloudflare_account_id_cloudflare_account_id_fk" FOREIGN KEY ("cloudflare_account_id") REFERENCES "public"."cloudflare_account"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloudflare_tunnel" ADD CONSTRAINT "cloudflare_tunnel_server_id_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."server"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cloudflare_tunnel_server_account_idx" ON "cloudflare_tunnel" USING btree ("server_id","cloudflare_account_id");--> statement-breakpoint
ALTER TABLE "domain" ADD CONSTRAINT "domain_tunnel_id_cloudflare_tunnel_id_fk" FOREIGN KEY ("tunnel_id") REFERENCES "public"."cloudflare_tunnel"("id") ON DELETE set null ON UPDATE no action;