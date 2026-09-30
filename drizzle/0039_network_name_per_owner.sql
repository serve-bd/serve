DROP INDEX "private_network_name_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "private_network_name_idx" ON "private_network" USING btree (coalesce("organization_id", ''),lower("name"));