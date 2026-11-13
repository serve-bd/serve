CREATE TABLE "stack_run" (
	"id" text PRIMARY KEY NOT NULL,
	"environment_id" text NOT NULL,
	"stack_name" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"steps" jsonb NOT NULL,
	"user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "service" ADD COLUMN "stack_name" text;--> statement-breakpoint
ALTER TABLE "service" ADD COLUMN "stack_key" text;--> statement-breakpoint
ALTER TABLE "service" ADD COLUMN "stack_file" jsonb;--> statement-breakpoint
ALTER TABLE "stack_run" ADD CONSTRAINT "stack_run_environment_id_environment_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environment"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "stack_run_env_idx" ON "stack_run" USING btree ("environment_id","stack_name");--> statement-breakpoint
CREATE UNIQUE INDEX "service_stack_idx" ON "service" USING btree ("environment_id","stack_name","stack_key");