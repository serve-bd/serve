CREATE TABLE "metric_rollup" (
	"scope" text NOT NULL,
	"bucket" timestamp with time zone NOT NULL,
	"cpu" integer NOT NULL,
	"memory" bigint NOT NULL,
	"memory_limit" bigint,
	"net_rx" bigint,
	"net_tx" bigint,
	"disk" bigint,
	"disk_total" bigint,
	CONSTRAINT "metric_rollup_scope_bucket_pk" PRIMARY KEY("scope","bucket")
);
--> statement-breakpoint
ALTER TABLE "server" ADD COLUMN "metrics_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "server" ADD COLUMN "agent" jsonb;--> statement-breakpoint
-- History already collected becomes five-minute averages, so longer charts keep showing it.
INSERT INTO "metric_rollup" ("scope", "bucket", "cpu", "memory", "memory_limit", "net_rx", "net_tx", "disk", "disk_total")
SELECT "scope", date_bin('5 minutes', "created_at", TIMESTAMPTZ '2000-01-01'), round(avg("cpu"))::int, round(avg("memory"))::bigint, max("memory_limit"),
  max("net_rx"), max("net_tx"), round(avg("disk"))::bigint, max("disk_total")
FROM "metric"
GROUP BY 1, 2
ON CONFLICT DO NOTHING;
