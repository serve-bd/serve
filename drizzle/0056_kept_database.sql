CREATE TABLE "kept_database" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"server_id" text NOT NULL,
	"name" text NOT NULL,
	"engine" text NOT NULL,
	"version" text NOT NULL,
	"image" text,
	"username" text NOT NULL,
	"password" text NOT NULL,
	"database" text NOT NULL,
	"volume" text NOT NULL,
	"owned" boolean DEFAULT true NOT NULL,
	"data_mount_path" text,
	"pgdata" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "kept_database" ADD CONSTRAINT "kept_database_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kept_database" ADD CONSTRAINT "kept_database_server_id_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."server"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "kept_database_org_idx" ON "kept_database" USING btree ("organization_id");