CREATE TABLE "incident" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"service_id" text,
	"server_id" text,
	"kind" text NOT NULL,
	"key" text NOT NULL,
	"severity" text DEFAULT 'critical' NOT NULL,
	"title" text NOT NULL,
	"detail" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "monitor" (
	"id" text PRIMARY KEY NOT NULL,
	"service_id" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"kind" text DEFAULT 'http' NOT NULL,
	"url" text,
	"path" text DEFAULT '/' NOT NULL,
	"expected_status" text DEFAULT '200-399' NOT NULL,
	"keyword" text,
	"interval_seconds" integer DEFAULT 60 NOT NULL,
	"timeout_ms" integer DEFAULT 10000 NOT NULL,
	"failure_threshold" integer DEFAULT 3 NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"last_checked_at" timestamp with time zone,
	"last_latency_ms" integer,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "monitor_service_id_unique" UNIQUE("service_id")
);
--> statement-breakpoint
CREATE TABLE "monitor_check" (
	"id" text PRIMARY KEY NOT NULL,
	"monitor_id" text NOT NULL,
	"ok" boolean NOT NULL,
	"latency_ms" integer,
	"status_code" integer,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "monitor_daily" (
	"monitor_id" text NOT NULL,
	"day" text NOT NULL,
	"checks" integer DEFAULT 0 NOT NULL,
	"failures" integer DEFAULT 0 NOT NULL,
	"latency_sum" bigint DEFAULT 0 NOT NULL,
	"latency_count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "server_alerts" (
	"server_id" text PRIMARY KEY NOT NULL,
	"config" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "incident" ADD CONSTRAINT "incident_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incident" ADD CONSTRAINT "incident_service_id_service_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."service"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incident" ADD CONSTRAINT "incident_server_id_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."server"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitor" ADD CONSTRAINT "monitor_service_id_service_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."service"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitor_check" ADD CONSTRAINT "monitor_check_monitor_id_monitor_id_fk" FOREIGN KEY ("monitor_id") REFERENCES "public"."monitor"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitor_daily" ADD CONSTRAINT "monitor_daily_monitor_id_monitor_id_fk" FOREIGN KEY ("monitor_id") REFERENCES "public"."monitor"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_alerts" ADD CONSTRAINT "server_alerts_server_id_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."server"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "incident_org_idx" ON "incident" USING btree ("organization_id","started_at");--> statement-breakpoint
CREATE INDEX "incident_key_idx" ON "incident" USING btree ("key","resolved_at");--> statement-breakpoint
CREATE INDEX "monitor_check_monitor_idx" ON "monitor_check" USING btree ("monitor_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "monitor_daily_idx" ON "monitor_daily" USING btree ("monitor_id","day");