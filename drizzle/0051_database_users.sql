CREATE TABLE "database_user" (
	"id" text PRIMARY KEY NOT NULL,
	"service_id" text NOT NULL,
	"username" text NOT NULL,
	"password" text NOT NULL,
	"access" text NOT NULL,
	"databases" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "database_user" ADD CONSTRAINT "database_user_service_id_service_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."service"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "database_user_service_username_idx" ON "database_user" USING btree ("service_id","username");