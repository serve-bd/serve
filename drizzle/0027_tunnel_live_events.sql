-- Live updates for Cloudflare Tunnels: a tunnel added, removed or changing status is announced
-- on "serve_events", so open pages show "Tunnel starting" turning into "Tunnel" without a reload.
CREATE OR REPLACE FUNCTION serve_notify_tunnel_change() RETURNS trigger AS $$
DECLARE
  rec record;
BEGIN
  IF TG_OP = 'DELETE' THEN rec := OLD; ELSE rec := NEW; END IF;
  PERFORM pg_notify('serve_events', json_build_object('t', 'tunnel', 'op', TG_OP, 'org', rec.organization_id, 'project', NULL, 'service', NULL)::text);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER serve_tunnel_insert_delete AFTER INSERT OR DELETE ON cloudflare_tunnel FOR EACH ROW EXECUTE FUNCTION serve_notify_tunnel_change();
--> statement-breakpoint
-- The worker writes the status every minute: only a real change is announced.
CREATE TRIGGER serve_tunnel_status AFTER UPDATE OF status ON cloudflare_tunnel FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status) EXECUTE FUNCTION serve_notify_tunnel_change();
