-- More live updates on "serve_events", so pages follow long-running work without polling.
-- Service-scoped rows (backups, task runs) reuse serve_notify_change from 0024. Log and output
-- writes do not count: only a row appearing, going away or changing status.
CREATE TRIGGER serve_backup_insert_delete AFTER INSERT OR DELETE ON backup FOR EACH ROW EXECUTE FUNCTION serve_notify_change();
--> statement-breakpoint
CREATE TRIGGER serve_backup_status AFTER UPDATE OF status, restore_status ON backup FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status OR OLD.restore_status IS DISTINCT FROM NEW.restore_status)
  EXECUTE FUNCTION serve_notify_change();
--> statement-breakpoint
CREATE TRIGGER serve_task_run_insert_delete AFTER INSERT OR DELETE ON task_run FOR EACH ROW EXECUTE FUNCTION serve_notify_change();
--> statement-breakpoint
CREATE TRIGGER serve_task_run_status AFTER UPDATE OF status ON task_run FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION serve_notify_change();
--> statement-breakpoint
-- Rows with no project: the event names the kind (first trigger argument) and the organization,
-- or none for instance-wide rows (servers, settings), which every signed-in member may hear about.
CREATE OR REPLACE FUNCTION serve_notify_row_change() RETURNS trigger AS $$
DECLARE
  rec record;
BEGIN
  IF TG_OP = 'DELETE' THEN rec := OLD; ELSE rec := NEW; END IF;
  PERFORM pg_notify('serve_events', json_build_object('t', TG_ARGV[0], 'op', TG_OP, 'org', to_jsonb(rec)->>'organization_id', 'project', NULL, 'service', NULL)::text);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER serve_certificate_change AFTER INSERT OR DELETE OR UPDATE OF status ON certificate FOR EACH ROW EXECUTE FUNCTION serve_notify_row_change('certificate');
--> statement-breakpoint
CREATE TRIGGER serve_server_change AFTER INSERT OR DELETE ON server FOR EACH ROW EXECUTE FUNCTION serve_notify_row_change('server');
--> statement-breakpoint
CREATE TRIGGER serve_server_update AFTER UPDATE OF status, proxy_switch, mesh ON server FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status OR OLD.proxy_switch IS DISTINCT FROM NEW.proxy_switch OR OLD.mesh IS DISTINCT FROM NEW.mesh)
  EXECUTE FUNCTION serve_notify_row_change('server');
--> statement-breakpoint
-- Only settings that track running work; the worker heartbeat and the like stay quiet.
CREATE TRIGGER serve_setting_write AFTER INSERT OR UPDATE ON setting FOR EACH ROW
  WHEN (NEW.key IN ('cleanupHistory', 'instanceBackups', 'updateRun'))
  EXECUTE FUNCTION serve_notify_row_change('setting');
--> statement-breakpoint
CREATE TRIGGER serve_setting_delete AFTER DELETE ON setting FOR EACH ROW
  WHEN (OLD.key IN ('cleanupHistory', 'instanceBackups', 'updateRun'))
  EXECUTE FUNCTION serve_notify_row_change('setting');
