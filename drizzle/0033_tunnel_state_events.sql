-- A server's tunnel coming up or going down, and the tunnel listener's state, show live.
DROP TRIGGER IF EXISTS serve_server_update ON server;
--> statement-breakpoint
CREATE TRIGGER serve_server_update AFTER UPDATE OF status, status_message, proxy_switch, mesh, tunnel ON server FOR EACH ROW
  WHEN (
    OLD.status IS DISTINCT FROM NEW.status
    OR OLD.status_message IS DISTINCT FROM NEW.status_message
    OR OLD.proxy_switch IS DISTINCT FROM NEW.proxy_switch
    OR OLD.mesh IS DISTINCT FROM NEW.mesh
    OR OLD.tunnel->>'connectedAt' IS DISTINCT FROM NEW.tunnel->>'connectedAt'
  )
  EXECUTE FUNCTION serve_notify_row_change('server');
--> statement-breakpoint
DROP TRIGGER IF EXISTS serve_setting_write ON setting;
--> statement-breakpoint
CREATE TRIGGER serve_setting_write AFTER INSERT ON setting FOR EACH ROW
  WHEN (NEW.key IN ('cleanupHistory', 'instanceBackups', 'updateRun', 'tunnelListener'))
  EXECUTE FUNCTION serve_notify_row_change('setting');
--> statement-breakpoint
DROP TRIGGER IF EXISTS serve_setting_update ON setting;
--> statement-breakpoint
CREATE TRIGGER serve_setting_update AFTER UPDATE ON setting FOR EACH ROW
  WHEN (
    NEW.key IN ('cleanupHistory', 'instanceBackups')
    OR (NEW.key = 'updateRun' AND OLD.value->>'state' IS DISTINCT FROM NEW.value->>'state')
    OR (NEW.key = 'tunnelListener' AND (OLD.value->>'listening' IS DISTINCT FROM NEW.value->>'listening' OR OLD.value->>'error' IS DISTINCT FROM NEW.value->>'error'))
  )
  EXECUTE FUNCTION serve_notify_row_change('setting');
