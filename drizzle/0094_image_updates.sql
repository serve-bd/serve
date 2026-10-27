ALTER TABLE "deployment" ADD COLUMN "pull_images" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "service" ADD COLUMN "image_check" jsonb;