CREATE TABLE "server_var" (
	"id" text PRIMARY KEY NOT NULL,
	"server_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"key" text NOT NULL,
	"value" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "env_var" ADD COLUMN "literal" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "env_var" ADD COLUMN "multiline" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "server_var" ADD CONSTRAINT "server_var_server_id_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."server"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_var" ADD CONSTRAINT "server_var_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "server_var_key_idx" ON "server_var" USING btree ("server_id","organization_id","key");