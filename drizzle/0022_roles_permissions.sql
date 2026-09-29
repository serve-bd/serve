CREATE TABLE "org_role" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"builtin" text,
	"name" text NOT NULL,
	"description" text,
	"permissions" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "invitation" ADD COLUMN "role_id" text;--> statement-breakpoint
ALTER TABLE "member" ADD COLUMN "role_id" text;--> statement-breakpoint
ALTER TABLE "member" ADD COLUMN "project_ids" text[];--> statement-breakpoint
ALTER TABLE "org_role" ADD CONSTRAINT "org_role_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "org_role_org_idx" ON "org_role" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "org_role_builtin_idx" ON "org_role" USING btree ("organization_id","builtin");--> statement-breakpoint
-- Existing organizations keep today's behaviour: members (now Developers) still see secret values.
-- New organizations start with the stricter default, where Developers cannot see them.
INSERT INTO "org_role" ("id", "organization_id", "builtin", "name", "permissions")
SELECT substr(md5(random()::text || o."id"), 1, 16), o."id", 'developer', 'Developer',
  ARRAY['projects.view','services.deploy','services.manage','domains.manage','variables.edit','variables.view-secrets','databases.backups','logs.view','console.access']::text[]
FROM "organization" o
ON CONFLICT DO NOTHING;
