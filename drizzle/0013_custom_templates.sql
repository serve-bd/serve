CREATE TABLE "custom_template" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"category" text DEFAULT 'Custom' NOT NULL,
	"icon_url" text,
	"compose" text NOT NULL,
	"vars" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"expose_service" text,
	"expose_port" integer,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "custom_template" ADD CONSTRAINT "custom_template_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_template" ADD CONSTRAINT "custom_template_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "custom_template_org_idx" ON "custom_template" USING btree ("organization_id");