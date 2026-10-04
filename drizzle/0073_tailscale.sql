CREATE TABLE "tailscale_tailnet" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"tailnet" text NOT NULL,
	"auth_type" text NOT NULL,
	"client_id" text,
	"secret" text NOT NULL,
	"access_token" text,
	"token_expires_at" timestamp with time zone,
	"tag" text DEFAULT 'tag:serve' NOT NULL,
	"dns_suffix" text,
	"error" text,
	"checked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "server" ADD COLUMN "tailscale" jsonb;--> statement-breakpoint
-- A server joining the tailnet, going on or offline there, or losing it shows live (and a tunnel coming up again, as in 0033).
DROP TRIGGER IF EXISTS serve_server_update ON server;
--> statement-breakpoint
CREATE TRIGGER serve_server_update AFTER UPDATE OF status, status_message, proxy_switch, mesh, os_updates, tunnel, tailscale ON server FOR EACH ROW
  WHEN (
    OLD.status IS DISTINCT FROM NEW.status
    OR OLD.status_message IS DISTINCT FROM NEW.status_message
    OR OLD.proxy_switch IS DISTINCT FROM NEW.proxy_switch
    OR OLD.mesh IS DISTINCT FROM NEW.mesh
    OR OLD.os_updates IS DISTINCT FROM NEW.os_updates
    OR OLD.tunnel->>'connectedAt' IS DISTINCT FROM NEW.tunnel->>'connectedAt'
    OR (OLD.tailscale IS NULL) IS DISTINCT FROM (NEW.tailscale IS NULL)
    OR OLD.tailscale->>'tailnetId' IS DISTINCT FROM NEW.tailscale->>'tailnetId'
    OR OLD.tailscale->>'address' IS DISTINCT FROM NEW.tailscale->>'address'
    OR OLD.tailscale->>'online' IS DISTINCT FROM NEW.tailscale->>'online'
    OR OLD.tailscale->>'error' IS DISTINCT FROM NEW.tailscale->>'error'
  )
  EXECUTE FUNCTION serve_notify_row_change('server');
