ALTER TABLE "server" ADD COLUMN "build_concurrency" integer DEFAULT 2 NOT NULL;--> statement-breakpoint
ALTER TABLE "server" ADD COLUMN "image_retention" integer DEFAULT 5 NOT NULL;--> statement-breakpoint
ALTER TABLE "server" ADD COLUMN "metrics_retention_hours" integer DEFAULT 48 NOT NULL;--> statement-breakpoint
-- Builds and limits moved from the instance settings to each server: every server starts with the values set before.
UPDATE "server" SET
  "build_concurrency" = COALESCE((SELECT ("value" #>> '{}')::int FROM "setting" WHERE "key" = 'buildConcurrency' AND ("value" #>> '{}') ~ '^[0-9]+$'), "build_concurrency"),
  "image_retention" = COALESCE((SELECT ("value" #>> '{}')::int FROM "setting" WHERE "key" = 'imageRetention' AND ("value" #>> '{}') ~ '^[0-9]+$'), "image_retention"),
  "metrics_retention_hours" = COALESCE((SELECT ("value" #>> '{}')::int FROM "setting" WHERE "key" = 'metricsRetentionHours' AND ("value" #>> '{}') ~ '^[0-9]+$'), "metrics_retention_hours");--> statement-breakpoint
-- A custom upload limit becomes each server's own nginx limit, unless the server already set one.
UPDATE "server" SET "proxy_config" = COALESCE("proxy_config", '{}'::jsonb) || jsonb_build_object(
  'nginx', COALESCE("proxy_config"->'nginx', '{}'::jsonb) || jsonb_build_object('maxBodySize', (SELECT "value" #>> '{}' FROM "setting" WHERE "key" = 'proxyMaxBodySize'))
)
WHERE EXISTS (SELECT 1 FROM "setting" WHERE "key" = 'proxyMaxBodySize' AND ("value" #>> '{}') NOT IN ('', '100m'))
  AND COALESCE("proxy_config"->'nginx'->>'maxBodySize', '') = '';--> statement-breakpoint
DELETE FROM "setting" WHERE "key" IN ('buildConcurrency', 'imageRetention', 'metricsRetentionHours', 'proxyMaxBodySize');
