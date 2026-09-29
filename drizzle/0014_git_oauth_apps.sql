CREATE TABLE "git_oauth_app" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"provider" text NOT NULL,
	"name" text NOT NULL,
	"base_url" text,
	"client_id" text NOT NULL,
	"client_secret" text NOT NULL,
	"group_path" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "git_credential" ADD COLUMN "oauth_app_id" text;--> statement-breakpoint
ALTER TABLE "git_oauth_app" ADD CONSTRAINT "git_oauth_app_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_credential" ADD CONSTRAINT "git_credential_oauth_app_id_git_oauth_app_id_fk" FOREIGN KEY ("oauth_app_id") REFERENCES "public"."git_oauth_app"("id") ON DELETE cascade ON UPDATE no action;