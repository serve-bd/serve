import { z } from "zod";

/** One entry of Persistent storage: a Docker volume, a host path, or a file Serve writes. */
export const volumeSchema = z
  .object({
    source: z.string().trim().min(1, "Enter a name or path").max(500),
    mountPath: z
      .string()
      .trim()
      .regex(/^\/[^:]*$/, "Mount paths must be absolute")
      .max(500),
    kind: z.enum(["volume", "bind", "file"]),
    readOnly: z.boolean().optional(),
    content: z.string().max(256_000, "Files are limited to 250 KB").optional(),
    hostType: z.enum(["file", "directory"]).optional(),
    create: z.boolean().optional(),
  })
  .superRefine((v, ctx) => {
    if (v.kind === "volume" && !/^[a-zA-Z0-9][\w.-]*$/.test(v.source)) ctx.addIssue({ code: "custom", message: "Volume names use letters, numbers, dots and dashes." });
    if (v.kind === "bind" && !/^\/[^:]*$/.test(v.source)) ctx.addIssue({ code: "custom", message: "Host paths must be absolute." });
    if (v.kind === "file" && !/^[\w][\w.-]*$/.test(v.source)) ctx.addIssue({ code: "custom", message: "File names use letters, numbers, dots and dashes." });
  });

const normalPath = (p: string) => (p.length > 1 ? p.trim().replace(/\/+$/, "") : p.trim());

/** Persistent storage of one service: each container path is mounted once, and never on / itself. */
export const volumeListSchema = z
  .array(volumeSchema)
  .max(50)
  .superRefine((list, ctx) => {
    const seen = new Set<string>();
    for (const v of list) {
      const path = normalPath(v.mountPath);
      if (path === "/") ctx.addIssue({ code: "custom", message: "Mount a path inside the container, like /data, not / itself." });
      else if (seen.has(path)) ctx.addIssue({ code: "custom", message: `${path} is mounted twice. Each container path can have one mount.` });
      seen.add(path);
    }
  });
