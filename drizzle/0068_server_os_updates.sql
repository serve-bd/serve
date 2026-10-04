ALTER TABLE "server" ADD COLUMN "os_updates" jsonb;--> statement-breakpoint
-- The Updates page of a server follows a check or an install as it goes.
DROP TRIGGER IF EXISTS serve_server_update ON server;
--> statement-breakpoint
CREATE TRIGGER serve_server_update AFTER UPDATE OF status, status_message, proxy_switch, mesh, os_updates ON server FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status OR OLD.status_message IS DISTINCT FROM NEW.status_message OR OLD.proxy_switch IS DISTINCT FROM NEW.proxy_switch OR OLD.mesh IS DISTINCT FROM NEW.mesh OR OLD.os_updates IS DISTINCT FROM NEW.os_updates)
  EXECUTE FUNCTION serve_notify_row_change('server');
