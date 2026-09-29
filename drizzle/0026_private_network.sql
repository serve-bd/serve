CREATE TABLE "mesh_address" (
	"id" text PRIMARY KEY NOT NULL,
	"server_id" text NOT NULL,
	"key" text NOT NULL,
	"service_id" text,
	"environment_id" text,
	"ip" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "server" ADD COLUMN "mesh_index" integer;--> statement-breakpoint
ALTER TABLE "server" ADD COLUMN "mesh" jsonb;--> statement-breakpoint
ALTER TABLE "mesh_address" ADD CONSTRAINT "mesh_address_server_id_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."server"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mesh_address" ADD CONSTRAINT "mesh_address_service_id_service_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."service"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mesh_address" ADD CONSTRAINT "mesh_address_environment_id_environment_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environment"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mesh_address_key_idx" ON "mesh_address" USING btree ("server_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "mesh_address_ip_idx" ON "mesh_address" USING btree ("ip");--> statement-breakpoint
ALTER TABLE "server" ADD CONSTRAINT "server_mesh_index_unique" UNIQUE("mesh_index");