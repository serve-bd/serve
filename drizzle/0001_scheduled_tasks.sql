CREATE TABLE "scheduled_task" (
	"id" text PRIMARY KEY NOT NULL,
	"service_id" text NOT NULL,
	"name" text NOT NULL,
	"schedule" text NOT NULL,
	"command" text NOT NULL,
	"compose_service" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"timeout_seconds" integer DEFAULT 3600 NOT NULL,
	"last_run_at" timestamp with time zone,
	"last_status" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_run" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text,
	"service_id" text NOT NULL,
	"command" text NOT NULL,
	"trigger" text DEFAULT 'schedule' NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"exit_code" integer,
	"output" text DEFAULT '' NOT NULL,
	"user_id" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "scheduled_task" ADD CONSTRAINT "scheduled_task_service_id_service_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."service"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_run" ADD CONSTRAINT "task_run_task_id_scheduled_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."scheduled_task"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_run" ADD CONSTRAINT "task_run_service_id_service_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."service"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_run" ADD CONSTRAINT "task_run_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "scheduled_task_service_idx" ON "scheduled_task" USING btree ("service_id");--> statement-breakpoint
CREATE INDEX "task_run_task_idx" ON "task_run" USING btree ("task_id","started_at");--> statement-breakpoint
CREATE INDEX "task_run_service_idx" ON "task_run" USING btree ("service_id","started_at");