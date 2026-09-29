import { eq } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { enqueue } from "@/server/queue";
import { logActivity } from "@/server/activity";
import { queueDeployment } from "./create";

type Service = typeof schema.service.$inferSelect;
export type ServiceCommand = "stop" | "start" | "restart";

/** Queue a stop, start or restart. A start without containers becomes a deployment. */
export async function requestServiceControl(service: Service, command: ServiceCommand, userId: string | null) {
  if (command === "start") {
    const hasContainers = service.currentDeploymentId || service.type === "database";
    if (!hasContainers) {
      const deploymentId = await queueDeployment(service.id, "manual", { userId });
      return { deploymentId };
    }
  }
  await db
    .update(schema.service)
    .set({ status: command === "stop" ? "stopped" : command === "restart" ? "restarting" : "deploying" })
    .where(eq(schema.service.id, service.id));
  await enqueue(`service.${command}`, { serviceId: service.id }, { concurrencyKey: `service:${service.id}` });
  await logActivity({
    userId,
    projectId: service.projectId,
    action: `service.${command}`,
    targetType: "service",
    targetId: service.id,
    message: `${command === "stop" ? "Stopped" : command === "start" ? "Started" : "Restarted"} ${service.name}`,
  });
  return { deploymentId: null };
}
