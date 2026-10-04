CREATE TABLE "cloudflare_credential" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"auth_type" text DEFAULT 'token' NOT NULL,
	"secret" text NOT NULL,
	"refresh_token" text,
	"token_expires_at" timestamp with time zone,
	"origin_ca_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cloudflare_account" ADD COLUMN "credential_id" text;--> statement-breakpoint
ALTER TABLE "cloudflare_credential" ADD CONSTRAINT "cloudflare_credential_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloudflare_account" ADD CONSTRAINT "cloudflare_account_credential_id_cloudflare_credential_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."cloudflare_credential"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Each existing account keeps its own login: a credential with the account's id, holding its token.
INSERT INTO "cloudflare_credential" ("id", "organization_id", "auth_type", "secret", "refresh_token", "token_expires_at", "origin_ca_key", "created_at", "updated_at")
SELECT "id", "organization_id", "auth_type", "api_token", "refresh_token", "token_expires_at", "origin_ca_key", "created_at", "updated_at" FROM "cloudflare_account";--> statement-breakpoint
UPDATE "cloudflare_account" SET "credential_id" = "id";
