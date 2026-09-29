import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireOrg } from "@/server/auth";
import { serviceInOrg } from "@/server/services/access";
import { execCommand, execTargets, pickContainer } from "@/server/services/exec";
import { logActivity } from "@/server/activity";

export const dynamic = "force-dynamic";

/** Containers available for the console. */
export async function GET(_req: NextRequest, ctx: RouteContext<"/api/services/[serviceId]/exec">) {
  const { serviceId } = await ctx.params;
  const org = await requireOrg();
  try {
    const { service } = await serviceInOrg(serviceId, org.org.id);
    return NextResponse.json({ targets: (await execTargets(service)).map((t) => ({ name: t.name, composeService: t.composeService })) });
  } catch {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
}

const bodySchema = z.object({ command: z.string().trim().min(1).max(4000), target: z.string().nullable().optional() });

/** Run a one-off command and stream its output as plain text. The last line is "\u0000<exit code>". */
export async function POST(request: NextRequest, ctx: RouteContext<"/api/services/[serviceId]/exec">) {
  const { serviceId } = await ctx.params;
  const org = await requireOrg();
  let service;
  try {
    service = (await serviceInOrg(serviceId, org.org.id)).service;
  } catch {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "Enter a command" }, { status: 400 });
  let container;
  try {
    container = await pickContainer(service, parsed.data.target);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 409 });
  }
  await logActivity({ userId: org.user.id, projectId: service.projectId, action: "service.exec", targetType: "service", targetId: service.id, message: `Ran \`${parsed.data.command.slice(0, 80)}\` in ${service.name}` });

  const encoder = new TextEncoder();
  const abort = new AbortController();
  request.signal.addEventListener("abort", () => abort.abort());
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const push = (text: string) => {
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          abort.abort();
        }
      };
      try {
        const result = await execCommand(container.id, parsed.data.command, { onData: push, signal: abort.signal, timeoutSeconds: 900, docker: container.docker });
        push(`\n\u0000${result.exitCode}`);
      } catch (e) {
        push(`${(e as Error).message}\n\u00001`);
      }
      try {
        controller.close();
      } catch {}
    },
    cancel() {
      abort.abort();
    },
  });
  return new Response(body, { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-cache", "x-accel-buffering": "no" } });
}
