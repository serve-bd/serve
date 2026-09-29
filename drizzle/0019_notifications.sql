CREATE TABLE "notification_delivery" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"event" text NOT NULL,
	"severity" text NOT NULL,
	"title" text NOT NULL,
	"status" text NOT NULL,
	"error" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"group_key" text NOT NULL,
	"message" jsonb NOT NULL,
	"test" boolean DEFAULT false NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "notification_channel" ADD COLUMN "scope" jsonb;--> statement-breakpoint
ALTER TABLE "notification_channel" ADD COLUMN "min_severity" text DEFAULT 'info' NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_channel" ADD COLUMN "quiet_hours" jsonb;--> statement-breakpoint
ALTER TABLE "notification_channel" ADD COLUMN "throttle_minutes" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_channel" ADD COLUMN "template" jsonb;--> statement-breakpoint
ALTER TABLE "notification_channel" ADD COLUMN "last_delivery_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "notification_channel" ADD COLUMN "last_delivery_status" text;--> statement-breakpoint
ALTER TABLE "notification_channel" ADD COLUMN "last_delivery_error" text;--> statement-breakpoint
ALTER TABLE "notification_channel" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_delivery" ADD CONSTRAINT "notification_delivery_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_delivery" ADD CONSTRAINT "notification_delivery_channel_id_notification_channel_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."notification_channel"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notification_delivery_channel_idx" ON "notification_delivery" USING btree ("channel_id","created_at");--> statement-breakpoint
CREATE INDEX "notification_delivery_org_idx" ON "notification_delivery" USING btree ("organization_id","created_at");