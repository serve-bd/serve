CREATE TABLE "status_subscriber" (
	"id" text PRIMARY KEY NOT NULL,
	"page_id" text NOT NULL,
	"kind" text NOT NULL,
	"target" text NOT NULL,
	"target_hash" text NOT NULL,
	"component_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"confirmed" boolean DEFAULT false NOT NULL,
	"token" text NOT NULL,
	"failures" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"last_sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "status_subscriber_token_unique" UNIQUE("token")
);
--> statement-breakpoint
ALTER TABLE "status_notice" ADD COLUMN "start_notified" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "status_notice" ADD COLUMN "end_notified" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "status_page" ADD COLUMN "subscribe" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "status_page" ADD COLUMN "team_channel_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "status_subscriber" ADD CONSTRAINT "status_subscriber_page_id_status_page_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."status_page"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "status_subscriber_target_idx" ON "status_subscriber" USING btree ("page_id","target_hash");--> statement-breakpoint
CREATE INDEX "status_subscriber_page_idx" ON "status_subscriber" USING btree ("page_id","confirmed");--> statement-breakpoint
-- Windows from before subscriptions existed were announced already, as far as anyone is concerned.
UPDATE "status_notice" SET "start_notified" = true WHERE "kind" = 'maintenance' AND "starts_at" <= now();--> statement-breakpoint
UPDATE "status_notice" SET "end_notified" = true WHERE "kind" = 'maintenance' AND ("ends_at" <= now() OR "resolved_at" IS NOT NULL);
