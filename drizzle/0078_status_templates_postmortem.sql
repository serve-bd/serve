ALTER TABLE "status_notice" ADD COLUMN "postmortem" text;--> statement-breakpoint
ALTER TABLE "status_page" ADD COLUMN "templates" jsonb DEFAULT '[]'::jsonb NOT NULL;