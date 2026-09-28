CREATE TABLE "request_metric" (
	"hostname" text NOT NULL,
	"minute" timestamp with time zone NOT NULL,
	"requests" integer DEFAULT 0 NOT NULL,
	"s2xx" integer DEFAULT 0 NOT NULL,
	"s3xx" integer DEFAULT 0 NOT NULL,
	"s4xx" integer DEFAULT 0 NOT NULL,
	"s5xx" integer DEFAULT 0 NOT NULL,
	"bytes" bigint DEFAULT 0 NOT NULL,
	"duration_ms" bigint DEFAULT 0 NOT NULL,
	"max_ms" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "request_metric_pk" ON "request_metric" USING btree ("hostname","minute");