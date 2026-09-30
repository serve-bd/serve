-- Host-level compose options now need a stack set up by an admin of the Root organization.
-- Stacks of the Root organization that exist today keep working: they are marked as such.
UPDATE service SET compose = compose || '{"hostAccess": true}'::jsonb
WHERE type = 'compose' AND compose IS NOT NULL
  AND project_id IN (SELECT id FROM project WHERE organization_id = (SELECT value #>> '{}' FROM setting WHERE key = 'rootOrganizationId'));
