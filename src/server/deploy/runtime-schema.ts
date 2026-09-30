import { isIP } from "node:net";
import { z } from "zod";
import { dnsOptionProblem, PLATFORMS, sysctlProblem, ulimitProblem } from "./options";

/** Validation of the container options for GPUs, devices, limits, kernel parameters, DNS and platform. */
export const containerOptionsSchema = {
  entrypoint: z.array(z.string().max(4000)).max(100).nullable(),
  gpus: z.union([z.literal("all"), z.number().int().min(1).max(16)]).nullable(),
  devices: z
    .array(
      z.object({
        host: z
          .string()
          .trim()
          .regex(/^\/dev\/[\w./:-]+$/, "Use a device path under /dev, like /dev/ttyUSB0")
          .refine((p) => !p.split("/").includes(".."), "Use a device path under /dev, like /dev/ttyUSB0"),
        container: z
          .string()
          .trim()
          .regex(/^\/[\w./:-]+$/, "Use an absolute path in the container")
          .optional(),
        permissions: z.enum(["rwm", "r", "rw"]).optional(),
      }),
    )
    .max(20),
  ulimits: z
    .array(
      z.object({ name: z.string().trim(), soft: z.number(), hard: z.number() }).superRefine((u, ctx) => {
        const problem = ulimitProblem(u);
        if (problem) ctx.addIssue({ code: "custom", message: problem });
      }),
    )
    .max(15)
    .refine((list) => new Set(list.map((u) => u.name)).size === list.length, "Set each limit once."),
  sysctls: z.record(z.string(), z.string()).superRefine((map, ctx) => {
    const entries = Object.entries(map);
    if (entries.length > 50) ctx.addIssue({ code: "custom", message: "Set at most 50 kernel parameters." });
    for (const [k, v] of entries) {
      const problem = sysctlProblem(k, v);
      if (problem) ctx.addIssue({ code: "custom", message: problem });
    }
  }),
  dns: z
    .array(
      z
        .string()
        .trim()
        .refine((ip) => isIP(ip) !== 0, "DNS servers are IP addresses, like 1.1.1.1."),
    )
    .max(3, "Containers use at most 3 DNS servers."),
  dnsSearch: z
    .array(
      z
        .string()
        .trim()
        .regex(/^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i, "Use domains like example.internal"),
    )
    .max(6, "Use at most 6 search domains."),
  dnsOptions: z
    .array(
      z
        .string()
        .trim()
        .superRefine((o, ctx) => {
          const problem = dnsOptionProblem(o);
          if (problem) ctx.addIssue({ code: "custom", message: problem });
        }),
    )
    .max(10),
  platform: z.enum(PLATFORMS).nullable(),
  pullPolicy: z.enum(["always", "missing"]),
};
