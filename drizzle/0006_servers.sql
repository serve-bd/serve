CREATE TABLE "private_key" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"public_key" text NOT NULL,
	"private_key" text NOT NULL,
	"fingerprint" text NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "server" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"is_local" boolean DEFAULT false NOT NULL,
	"host" text NOT NULL,
	"port" integer DEFAULT 22 NOT NULL,
	"username" text DEFAULT 'root' NOT NULL,
	"private_key_id" text,
	"host_key" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"status_message" text,
	"setup_log" text DEFAULT '' NOT NULL,
	"info" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"data_dir" text DEFAULT '/data/serve' NOT NULL,
	"proxy_http_port" integer DEFAULT 80 NOT NULL,
	"proxy_https_port" integer DEFAULT 443 NOT NULL,
	"public_ip" text,
	"wildcard_domain" text,
	"sslip_fallback" boolean DEFAULT true NOT NULL,
	"organization_ids" text[],
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- The machine Serve runs on. Existing services and certificates move onto it.
INSERT INTO "server" ("id", "name", "is_local", "host", "status") VALUES ('local', 'localhost', true, 'localhost', 'ready') ON CONFLICT DO NOTHING;--> statement-breakpoint
ALTER TABLE "certificate" ADD COLUMN "server_id" text DEFAULT 'local' NOT NULL;--> statement-breakpoint
ALTER TABLE "service" ADD COLUMN "server_id" text DEFAULT 'local' NOT NULL;--> statement-breakpoint
ALTER TABLE "private_key" ADD CONSTRAINT "private_key_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server" ADD CONSTRAINT "server_private_key_id_private_key_id_fk" FOREIGN KEY ("private_key_id") REFERENCES "public"."private_key"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "certificate" ADD CONSTRAINT "certificate_server_id_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."server"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service" ADD CONSTRAINT "service_server_id_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."server"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "service_server_idx" ON "service" USING btree ("server_id");