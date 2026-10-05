CREATE TABLE "status_component" (
	"id" text PRIMARY KEY NOT NULL,
	"page_id" text NOT NULL,
	"service_id" text,
	"name" text NOT NULL,
	"description" text,
	"group_name" text,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "status_notice" (
	"id" text PRIMARY KEY NOT NULL,
	"page_id" text NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"impact" text DEFAULT 'major' NOT NULL,
	"state" text DEFAULT 'investigating' NOT NULL,
	"component_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"starts_at" timestamp with time zone,
	"ends_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "status_notice_update" (
	"id" text PRIMARY KEY NOT NULL,
	"notice_id" text NOT NULL,
	"state" text NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "status_page" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"domain" text,
	"https" boolean DEFAULT true NOT NULL,
	"certificate_id" text,
	"visibility" text DEFAULT 'draft' NOT NULL,
	"password_hash" text,
	"design" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"images" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "status_page_slug_unique" UNIQUE("slug"),
	CONSTRAINT "status_page_domain_unique" UNIQUE("domain")
);
--> statement-breakpoint
ALTER TABLE "status_component" ADD CONSTRAINT "status_component_page_id_status_page_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."status_page"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "status_component" ADD CONSTRAINT "status_component_service_id_service_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."service"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "status_notice" ADD CONSTRAINT "status_notice_page_id_status_page_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."status_page"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "status_notice_update" ADD CONSTRAINT "status_notice_update_notice_id_status_notice_id_fk" FOREIGN KEY ("notice_id") REFERENCES "public"."status_notice"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "status_page" ADD CONSTRAINT "status_page_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "status_page" ADD CONSTRAINT "status_page_certificate_id_certificate_id_fk" FOREIGN KEY ("certificate_id") REFERENCES "public"."certificate"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "status_component_page_idx" ON "status_component" USING btree ("page_id","position");--> statement-breakpoint
CREATE INDEX "status_notice_page_idx" ON "status_notice" USING btree ("page_id","created_at");--> statement-breakpoint
CREATE INDEX "status_notice_update_notice_idx" ON "status_notice_update" USING btree ("notice_id","created_at");