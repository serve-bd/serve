-- Setup progress ("Connecting", "Installing Docker"…) shows live on the servers list: the status
-- message counts as a server change too.
DROP TRIGGER IF EXISTS serve_server_update ON server;
--> statement-breakpoint
CREATE TRIGGER serve_server_update AFTER UPDATE OF status, status_message, proxy_switch, mesh ON server FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status OR OLD.status_message IS DISTINCT FROM NEW.status_message OR OLD.proxy_switch IS DISTINCT FROM NEW.proxy_switch OR OLD.mesh IS DISTINCT FROM NEW.mesh)
  EXECUTE FUNCTION serve_notify_row_change('server');
--> statement-breakpoint
-- A self-update writes its log line by line: only a change of its state is announced, not every
-- line (each announcement refreshes every open dashboard).
DROP TRIGGER IF EXISTS serve_setting_write ON setting;
--> statement-breakpoint
CREATE TRIGGER serve_setting_write AFTER INSERT ON setting FOR EACH ROW
  WHEN (NEW.key IN ('cleanupHistory', 'instanceBackups', 'updateRun'))
  EXECUTE FUNCTION serve_notify_row_change('setting');
--> statement-breakpoint
CREATE TRIGGER serve_setting_update AFTER UPDATE ON setting FOR EACH ROW
  WHEN (NEW.key IN ('cleanupHistory', 'instanceBackups') OR (NEW.key = 'updateRun' AND OLD.value->>'state' IS DISTINCT FROM NEW.value->>'state'))
  EXECUTE FUNCTION serve_notify_row_change('setting');
