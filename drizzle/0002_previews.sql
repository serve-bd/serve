ALTER TABLE "service" ADD COLUMN "previews_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "service" ADD COLUMN "parent_service_id" text;--> statement-breakpoint
ALTER TABLE "service" ADD COLUMN "preview_pr" integer;--> statement-breakpoint
ALTER TABLE "service" ADD CONSTRAINT "service_parent_service_id_service_id_fk" FOREIGN KEY ("parent_service_id") REFERENCES "public"."service"("id") ON DELETE cascade ON UPDATE no action;