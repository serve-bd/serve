ALTER TABLE "server" ADD COLUMN IF NOT EXISTS "proxy_kind" text DEFAULT 'nginx' NOT NULL;--> statement-breakpoint
ALTER TABLE "server" ADD COLUMN IF NOT EXISTS "proxy_config" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "server" ADD COLUMN IF NOT EXISTS "proxy_switch" jsonb;--> statement-breakpoint
ALTER TABLE "server" ADD COLUMN IF NOT EXISTS "proxy_stopped" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "server" ADD COLUMN IF NOT EXISTS "proxy_ports_customized" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "service" ADD COLUMN IF NOT EXISTS "proxy_custom" jsonb;