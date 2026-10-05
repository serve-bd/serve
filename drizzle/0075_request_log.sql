CREATE TABLE "request_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"service_id" text NOT NULL,
	"time" timestamp with time zone NOT NULL,
	"hostname" text NOT NULL,
	"method" text,
	"path" text NOT NULL,
	"query" boolean DEFAULT false NOT NULL,
	"status" integer NOT NULL,
	"duration_ms" integer NOT NULL,
	"bytes" bigint DEFAULT 0 NOT NULL,
	"ip" text,
	"user_agent" text,
	"referer" text,
	"upstream" text,
	"server_id" text
);
--> statement-breakpoint
ALTER TABLE "service" ADD COLUMN "request_log" jsonb;--> statement-breakpoint
ALTER TABLE "request_log" ADD CONSTRAINT "request_log_service_id_service_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."service"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "request_log_service_time_idx" ON "request_log" USING btree ("service_id","time");--> statement-breakpoint
CREATE INDEX "request_log_service_status_time_idx" ON "request_log" USING btree ("service_id","status","time");