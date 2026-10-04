CREATE TABLE "scheduler_run" (
	"name" text PRIMARY KEY NOT NULL,
	"interval_ms" integer NOT NULL,
	"last_started_at" timestamp with time zone,
	"last_finished_at" timestamp with time zone,
	"last_duration_ms" integer,
	"last_error" text,
	"last_failed_at" timestamp with time zone,
	"runs" integer DEFAULT 0 NOT NULL,
	"failures" integer DEFAULT 0 NOT NULL,
	"skipped" integer DEFAULT 0 NOT NULL,
	"last_skipped_at" timestamp with time zone
);
