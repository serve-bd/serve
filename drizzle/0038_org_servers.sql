ALTER TABLE "private_key" ADD COLUMN "organization_id" text;--> statement-breakpoint
ALTER TABLE "private_network" ADD COLUMN "organization_id" text;--> statement-breakpoint
ALTER TABLE "server" ADD COLUMN "owner_organization_id" text;--> statement-breakpoint
ALTER TABLE "private_key" ADD CONSTRAINT "private_key_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "private_network" ADD CONSTRAINT "private_network_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server" ADD CONSTRAINT "server_owner_organization_id_organization_id_fk" FOREIGN KEY ("owner_organization_id") REFERENCES "public"."organization"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Servers open to every organization stay open to today's organizations; organizations created later get no shared servers until a Root admin adds them.
UPDATE "server" SET "organization_ids" = COALESCE((SELECT array_agg("id") FROM "organization"), '{}') WHERE "organization_ids" IS NULL;
