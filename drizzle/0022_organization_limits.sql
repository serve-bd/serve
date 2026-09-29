CREATE TABLE "organization_limit" (
	"organization_id" text PRIMARY KEY NOT NULL,
	"custom" boolean DEFAULT false NOT NULL,
	"limits" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"notified" text[] DEFAULT '{}'::text[] NOT NULL,
	"disk_bytes" bigint,
	"disk_measured_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "organization_limit" ADD CONSTRAINT "organization_limit_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;