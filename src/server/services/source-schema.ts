import { z } from "zod";
import { dockerfileBase } from "@/lib/dockerfile";
import { DOCKERFILE_MAX_BYTES } from "./types";

/** A Dockerfile source: the Dockerfile Serve builds, without a repository. */
export const dockerfileSourceSchema = z.object({
  type: z.literal("dockerfile"),
  content: z
    .string()
    .refine((v) => v.trim().length > 0, "Paste a Dockerfile.")
    .refine((v) => Buffer.byteLength(v, "utf8") <= DOCKERFILE_MAX_BYTES, "The Dockerfile is limited to 64 KB.")
    .refine((v) => !v.trim() || dockerfileBase(v) !== null, "A Dockerfile starts from an image: add a FROM line."),
});
