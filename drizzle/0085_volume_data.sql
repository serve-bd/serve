CREATE TABLE "kept_volume" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"server_id" text NOT NULL,
	"project_id" text,
	"environment_id" text,
	"service_name" text NOT NULL,
	"service_type" text NOT NULL,
	"volume" text NOT NULL,
	"mount_path" text,
	"owned" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "volume_size" (
	"server_id" text NOT NULL,
	"name" text NOT NULL,
	"compose_project" text,
	"bytes" bigint NOT NULL,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "volume_size_server_id_name_pk" PRIMARY KEY("server_id","name")
);
--> statement-breakpoint
ALTER TABLE "kept_database" ADD COLUMN "project_id" text;--> statement-breakpoint
ALTER TABLE "kept_database" ADD COLUMN "environment_id" text;--> statement-breakpoint
ALTER TABLE "kept_volume" ADD CONSTRAINT "kept_volume_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kept_volume" ADD CONSTRAINT "kept_volume_server_id_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."server"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kept_volume" ADD CONSTRAINT "kept_volume_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kept_volume" ADD CONSTRAINT "kept_volume_environment_id_environment_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environment"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "volume_size" ADD CONSTRAINT "volume_size_server_id_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."server"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "kept_volume_org_idx" ON "kept_volume" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "kept_volume_environment_idx" ON "kept_volume" USING btree ("environment_id");--> statement-breakpoint
ALTER TABLE "kept_database" ADD CONSTRAINT "kept_database_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kept_database" ADD CONSTRAINT "kept_database_environment_id_environment_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environment"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "kept_database_environment_idx" ON "kept_database" USING btree ("environment_id");