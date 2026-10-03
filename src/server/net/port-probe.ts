import { db, schema } from "@/server/db";
import { imageExists, LABEL, pullImage } from "@/server/docker/client";
import { getServer } from "@/server/servers/context";

const PROBE_IMAGE = "alpine:3.22.6";

/**
 * Whether ip:port takes a TCP connection from outside, tested from another server Serve manages:
 * a public IP behind a router or a cloud firewall can have the port open on the machine and still
 * not answer from the internet. Null when there is no other server to test from (or none answers).
 */
export async function portAnswersFromOutside(ip: string, port: number, targetServerId: string): Promise<boolean | null> {
  const others = (await db.select({ id: schema.server.id, status: schema.server.status }).from(schema.server)).filter((s) => s.id !== targetServerId && s.status === "ready");
  for (const { id } of others) {
    const ctx = await getServer(id).catch(() => null);
    if (!ctx) continue;
    try {
      if (!(await imageExists(PROBE_IMAGE, ctx.docker))) await pullImage(PROBE_IMAGE, undefined, null, ctx.docker);
      const container = await ctx.docker.createContainer({
        Image: PROBE_IMAGE,
        Cmd: ["nc", "-z", "-w", "5", ip, String(port)],
        Labels: { [LABEL.managed]: "true", [LABEL.kind]: "helper" },
        HostConfig: { NetworkMode: "bridge" },
      });
      try {
        await container.start();
        const { StatusCode } = (await container.wait()) as { StatusCode: number };
        return StatusCode === 0;
      } finally {
        await container.remove({ force: true }).catch(() => {});
      }
    } catch {
      // This server could not run the test: try the next one.
    }
  }
  return null;
}
