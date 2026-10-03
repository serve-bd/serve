ALTER TABLE "deployment" ADD COLUMN "approved_by" text;--> statement-breakpoint
ALTER TABLE "deployment" ADD COLUMN "approved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "deploy_rules" jsonb;--> statement-breakpoint
ALTER TABLE "deployment" ADD CONSTRAINT "deployment_approved_by_user_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;