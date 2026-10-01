CREATE TABLE "database_branch" (
	"id" text PRIMARY KEY NOT NULL,
	"service_id" text NOT NULL,
	"name" text NOT NULL,
	"database" text NOT NULL,
	"username" text NOT NULL,
	"password" text NOT NULL,
	"status" text DEFAULT 'creating' NOT NULL,
	"error" text,
	"size_bytes" bigint,
	"copied_at" timestamp with time zone,
	"preview_service_id" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "database_branch" ADD CONSTRAINT "database_branch_service_id_service_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."service"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "database_branch" ADD CONSTRAINT "database_branch_preview_service_id_service_id_fk" FOREIGN KEY ("preview_service_id") REFERENCES "public"."service"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "database_branch_service_name_idx" ON "database_branch" USING btree ("service_id","name");--> statement-breakpoint
CREATE INDEX "database_branch_preview_idx" ON "database_branch" USING btree ("preview_service_id");