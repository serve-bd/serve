"use server";

import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { CronExpressionParser } from "cron-parser";
import { act, UserError } from "@/server/action";
import { requireOrg } from "@/server/auth";
import { db, schema } from "@/server/db";
import { newId } from "@/server/id";
import { serviceInOrg } from "@/server/services/access";
import { startTaskRun } from "@/server/services/tasks";
import { logActivity } from "@/server/activity";

const taskSchema = z.object({
  name: z.string().trim().min(1, "Enter a name").max(80),
  schedule: z
    .string()
    .trim()
    .refine((v) => {
      try {
        CronExpressionParser.parse(v);
        return v.split(/\s+/).length >= 5;
      } catch {
        return false;
      }
    }, "Enter a valid cron expression"),
  command: z.string().trim().min(1, "Enter a command").max(4000),
  composeService: z.string().nullable().optional(),
  timeoutSeconds: z.number().int().min(10).max(86400).default(3600),
  enabled: z.boolean().default(true),
});

async function taskInOrg(taskId: string, orgId: string) {
  const [task] = await db.select().from(schema.scheduledTask).where(eq(schema.scheduledTask.id, taskId));
  if (!task) throw new UserError("Task not found.");
  await serviceInOrg(task.serviceId, orgId);
  return task;
}

export async function saveTask(serviceId: string, taskId: string | null, input: z.input<typeof taskSchema>) {
  return act(async () => {
    const ctx = await requireOrg();
    const { service } = await serviceInOrg(serviceId, ctx.org.id);
    const data = taskSchema.parse(input);
    if (taskId) {
      await taskInOrg(taskId, ctx.org.id);
      await db.update(schema.scheduledTask).set(data).where(eq(schema.scheduledTask.id, taskId));
      return { id: taskId };
    }
    const id = newId();
    await db.insert(schema.scheduledTask).values({ id, serviceId, ...data });
    await logActivity({
      userId: ctx.user.id,
      projectId: service.projectId,
      action: "task.created",
      targetType: "service",
      targetId: serviceId,
      message: `Scheduled "${data.name}" on ${service.name}`,
    });
    return { id };
  });
}

export async function toggleTask(taskId: string, enabled: boolean) {
  return act(async () => {
    const ctx = await requireOrg();
    await taskInOrg(taskId, ctx.org.id);
    await db.update(schema.scheduledTask).set({ enabled }).where(eq(schema.scheduledTask.id, taskId));
    return null;
  });
}

export async function deleteTask(taskId: string) {
  return act(async () => {
    const ctx = await requireOrg();
    await taskInOrg(taskId, ctx.org.id);
    await db.delete(schema.scheduledTask).where(eq(schema.scheduledTask.id, taskId));
    return null;
  });
}

export async function runTaskNow(taskId: string) {
  return act(async () => {
    const ctx = await requireOrg();
    const task = await taskInOrg(taskId, ctx.org.id);
    const [running] = await db
      .select({ id: schema.taskRun.id })
      .from(schema.taskRun)
      .where(and(eq(schema.taskRun.taskId, taskId), eq(schema.taskRun.status, "running")));
    if (running) throw new UserError("This task is already running.");
    const id = await startTaskRun({ serviceId: task.serviceId, taskId, command: task.command, trigger: "manual", userId: ctx.user.id });
    return { id };
  });
}
