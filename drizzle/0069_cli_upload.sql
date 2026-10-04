CREATE TABLE "cli_login" (
	"id" text PRIMARY KEY NOT NULL,
	"device_code_hash" text NOT NULL,
	"user_code" text NOT NULL,
	"client" text NOT NULL,
	"version" text,
	"ip" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"user_id" text,
	"organization_id" text,
	"token" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cli_login_device_code_hash_unique" UNIQUE("device_code_hash"),
	CONSTRAINT "cli_login_user_code_unique" UNIQUE("user_code")
);
--> statement-breakpoint
ALTER TABLE "deployment" ADD COLUMN "upload" jsonb;--> statement-breakpoint
ALTER TABLE "cli_login" ADD CONSTRAINT "cli_login_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cli_login" ADD CONSTRAINT "cli_login_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cli_login_expires_idx" ON "cli_login" USING btree ("expires_at");