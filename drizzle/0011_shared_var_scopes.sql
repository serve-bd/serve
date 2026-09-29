ALTER TABLE "shared_var" ALTER COLUMN "environment_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "shared_var" ADD COLUMN "organization_id" text;--> statement-breakpoint
ALTER TABLE "shared_var" ADD COLUMN "project_id" text;--> statement-breakpoint
ALTER TABLE "shared_var" ADD CONSTRAINT "shared_var_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_var" ADD CONSTRAINT "shared_var_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "shared_var_project_key_idx" ON "shared_var" USING btree ("project_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "shared_var_org_key_idx" ON "shared_var" USING btree ("organization_id","key");--> statement-breakpoint
ALTER TABLE "shared_var" ADD CONSTRAINT "shared_var_one_scope" CHECK (num_nonnulls("shared_var"."organization_id", "shared_var"."project_id", "shared_var"."environment_id") = 1);