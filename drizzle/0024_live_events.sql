-- Live updates: every change to deployments, services and domains is announced on the
-- "serve_events" channel, so open dashboards refresh without polling.
CREATE OR REPLACE FUNCTION serve_notify_change() RETURNS trigger AS $$
DECLARE
  rec record;
  svc_id text;
  proj_id text;
  org_id text;
BEGIN
  IF TG_OP = 'DELETE' THEN rec := OLD; ELSE rec := NEW; END IF;
  IF TG_TABLE_NAME = 'service' THEN
    svc_id := rec.id;
    proj_id := rec.project_id;
  ELSE
    svc_id := rec.service_id;
    SELECT s.project_id INTO proj_id FROM service s WHERE s.id = svc_id;
  END IF;
  IF proj_id IS NOT NULL THEN
    SELECT p.organization_id INTO org_id FROM project p WHERE p.id = proj_id;
  END IF;
  PERFORM pg_notify('serve_events', json_build_object('t', TG_TABLE_NAME, 'op', TG_OP, 'org', org_id, 'project', proj_id, 'service', svc_id)::text);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER serve_deployment_change AFTER INSERT OR UPDATE OF status OR DELETE ON deployment FOR EACH ROW EXECUTE FUNCTION serve_notify_change();
--> statement-breakpoint
CREATE TRIGGER serve_service_change AFTER INSERT OR UPDATE OR DELETE ON service FOR EACH ROW EXECUTE FUNCTION serve_notify_change();
--> statement-breakpoint
CREATE TRIGGER serve_domain_change AFTER INSERT OR UPDATE OR DELETE ON domain FOR EACH ROW EXECUTE FUNCTION serve_notify_change();
