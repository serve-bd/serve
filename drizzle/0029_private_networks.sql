CREATE TABLE "private_network" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "private_network_member" (
	"network_id" text NOT NULL,
	"server_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "private_network_member_network_id_server_id_pk" PRIMARY KEY("network_id","server_id")
);
--> statement-breakpoint
ALTER TABLE "private_network_member" ADD CONSTRAINT "private_network_member_network_id_private_network_id_fk" FOREIGN KEY ("network_id") REFERENCES "public"."private_network"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "private_network_member" ADD CONSTRAINT "private_network_member_server_id_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."server"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "private_network_name_idx" ON "private_network" USING btree (lower("name"));--> statement-breakpoint
CREATE INDEX "private_network_member_server_idx" ON "private_network_member" USING btree ("server_id");--> statement-breakpoint
-- Servers that already joined the (single) private network keep talking to each other: they all go into "Default".
INSERT INTO "private_network" ("id", "name")
  SELECT substr(md5(random()::text || clock_timestamp()::text), 1, 16), 'Default'
  WHERE EXISTS (SELECT 1 FROM "server" WHERE "mesh_index" IS NOT NULL AND "mesh" IS NOT NULL);
--> statement-breakpoint
INSERT INTO "private_network_member" ("network_id", "server_id")
  SELECT n."id", s."id" FROM "server" s CROSS JOIN "private_network" n
  WHERE n."name" = 'Default' AND s."mesh_index" IS NOT NULL AND s."mesh" IS NOT NULL;
--> statement-breakpoint
-- Membership changes refresh open server pages like other server changes.
CREATE TRIGGER serve_private_network_member_change AFTER INSERT OR DELETE ON private_network_member FOR EACH ROW EXECUTE FUNCTION serve_notify_row_change('server');
--> statement-breakpoint
CREATE TRIGGER serve_private_network_change AFTER INSERT OR UPDATE OR DELETE ON private_network FOR EACH ROW EXECUTE FUNCTION serve_notify_row_change('server');
