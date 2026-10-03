-- The "Send" filter (minimum severity) is gone: the ticked events decide alone. Channels that
-- sent problems only, or critical ones only, keep getting the same messages: the events their
-- filter held back are unticked. Recoveries always passed the filter, so they stay ticked.
UPDATE "notification_channel"
SET "events" = ARRAY(
  SELECT e FROM unnest("events") AS e
  WHERE e NOT IN ('backup.success', 'certificate.renewed', 'deploy.success', 'instance.backup.success', 'instance.update.available', 'instance.update.success')
)
WHERE "min_severity" = 'warning';
--> statement-breakpoint
UPDATE "notification_channel"
SET "events" = ARRAY(
  SELECT e FROM unnest("events") AS e
  WHERE e NOT IN (
    'backup.success', 'certificate.renewed', 'deploy.success', 'instance.backup.success', 'instance.update.available', 'instance.update.success',
    'certificate.failed', 'deploy.failed', 'org.limit', 'server.disk', 'server.resource', 'task.failed'
  )
)
WHERE "min_severity" = 'critical';
--> statement-breakpoint
UPDATE "notification_channel" SET "min_severity" = 'info' WHERE "min_severity" <> 'info';
