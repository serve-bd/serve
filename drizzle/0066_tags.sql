CREATE TABLE "service_tag" (
	"service_id" text NOT NULL,
	"tag_id" text NOT NULL,
	CONSTRAINT "service_tag_service_id_tag_id_pk" PRIMARY KEY("service_id","tag_id")
);
--> statement-breakpoint
CREATE TABLE "tag" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"color" text DEFAULT 'gray' NOT NULL,
	"deploy_secret" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "service_tag" ADD CONSTRAINT "service_tag_service_id_service_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."service"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_tag" ADD CONSTRAINT "service_tag_tag_id_tag_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."tag"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tag" ADD CONSTRAINT "tag_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "service_tag_tag_idx" ON "service_tag" USING btree ("tag_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tag_org_name_idx" ON "tag" USING btree ("organization_id",lower("name"));