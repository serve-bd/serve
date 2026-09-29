CREATE TABLE "container_registry" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"host" text NOT NULL,
	"username" text NOT NULL,
	"password" text NOT NULL,
	"namespace" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "deployment" ADD COLUMN "registry_image" text;--> statement-breakpoint
ALTER TABLE "deployment" ADD COLUMN "targets" jsonb;--> statement-breakpoint
ALTER TABLE "service" ADD COLUMN "distribution" jsonb;--> statement-breakpoint
ALTER TABLE "container_registry" ADD CONSTRAINT "container_registry_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;