-- "auto" without a Dockerfile now builds with Railpack. Apps that already deployed from Git or
-- uploaded files keep Nixpacks, the builder they have been running with.
UPDATE "service"
SET "build" = jsonb_set(COALESCE("build", '{"builder":"auto","rootDir":"/","dockerfile":"Dockerfile"}'::jsonb), '{autoBuilder}', '"nixpacks"')
WHERE "type" = 'app'
  AND "source"->>'type' IN ('git', 'upload')
  AND COALESCE("build"->>'builder', 'auto') = 'auto'
  AND NOT ("build" ? 'autoBuilder')
  AND EXISTS (SELECT 1 FROM "deployment" d WHERE d."service_id" = "service"."id" AND d."status" = 'success');
