import { sql } from "drizzle-orm";
import { schema } from "@/server/db";

/** Services that run on a server as one of their extra servers. */
export const runsAsExtraOn = (serverId: string) => sql<boolean>`coalesce(${schema.service.distribution}->'extraServerIds', '[]'::jsonb) @> jsonb_build_array(${serverId}::text)`;

/** Services that use a registry. */
export const usesRegistry = (registryId: string) => sql<boolean>`${schema.service.distribution}->>'registryId' = ${registryId}`;
