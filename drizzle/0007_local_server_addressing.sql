-- Addressing of the local server moves from instance settings to its server row.
UPDATE "server" SET
  "public_ip" = COALESCE((SELECT "value" #>> '{}' FROM "setting" WHERE "key" = 'serverIp'), "public_ip"),
  "wildcard_domain" = COALESCE((SELECT "value" #>> '{}' FROM "setting" WHERE "key" = 'wildcardDomain'), "wildcard_domain"),
  "sslip_fallback" = COALESCE((SELECT ("value" #>> '{}')::boolean FROM "setting" WHERE "key" = 'sslipFallback'), "sslip_fallback")
WHERE "id" = 'local';
