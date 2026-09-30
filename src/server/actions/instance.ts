"use server";

import { and, eq } from "drizzle-orm";
import { CronExpressionParser } from "cron-parser";
import { z } from "zod";
import { act, UserError } from "@/server/action";
import { logActivity } from "@/server/activity";
import { requireInstanceAdmin } from "@/server/auth";
import { db, schema } from "@/server/db";
import { env } from "@/server/env";
import { deleteInstanceBackup, queueInstanceBackupRecord } from "@/server/instance/backups";
import { beginUpdate, checkForUpdates, installMode, updateAvailable, updaterLogs } from "@/server/instance/updates";
import { enqueue } from "@/server/queue";
import { getSettings, updateSettings } from "@/server/settings";

const backupSettingsSchema = z.object({
  schedule: z.string().trim().max(100).nullable(),
  retention: z.number().int().min(1).max(100),
  s3DestinationId: z.string().nullable(),
});

export async function saveInstanceBackupSettings(input: z.input<typeof backupSettingsSchema>) {
  return act(async () => {
    const ctx = await requireInstanceAdmin();
    const data = backupSettingsSchema.parse(input);
    const schedule = data.schedule || null;
    if (schedule) {
      try {
        CronExpressionParser.parse(schedule);
      } catch {
        throw new UserError("That schedule is not a valid cron expression.");
      }
    }
    if (data.s3DestinationId) {
      const settings = await getSettings();
      const [dest] = await db
        .select({ id: schema.s3Destination.id })
        .from(schema.s3Destination)
        .where(and(eq(schema.s3Destination.id, data.s3DestinationId), eq(schema.s3Destination.organizationId, settings.rootOrganizationId ?? "")));
      if (!dest) throw new UserError("Choose storage of the Root organization.");
    }
    await updateSettings({ instanceBackupSchedule: schedule, instanceBackupRetention: data.retention, instanceBackupS3DestinationId: data.s3DestinationId });
    await logActivity({ userId: ctx.user.id, organizationId: ctx.org.id, action: "instance.backup-settings", message: "Updated instance backup settings" });
    return null;
  });
}

export async function startInstanceBackup() {
  return act(async () => {
    const ctx = await requireInstanceAdmin();
    const settings = await getSettings();
    if (settings.instanceBackups.some((b) => b.status === "running")) throw new UserError("A backup is already running.");
    const backupId = await queueInstanceBackupRecord("manual");
    await enqueue("instance.backup", { backupId }, { concurrencyKey: "instance-backup" });
    await logActivity({ userId: ctx.user.id, organizationId: ctx.org.id, action: "instance.backup", message: "Started a backup of this instance" });
    return { backupId };
  });
}

export async function removeInstanceBackup(id: string) {
  return act(async () => {
    const ctx = await requireInstanceAdmin();
    const backup = (await getSettings()).instanceBackups.find((b) => b.id === id);
    if (!backup) throw new UserError("Backup not found.");
    if (backup.status === "running") throw new UserError("Wait until the backup finishes.");
    await deleteInstanceBackup(id);
    await logActivity({ userId: ctx.user.id, organizationId: ctx.org.id, action: "instance.backup-delete", message: `Deleted instance backup ${backup.filename ?? id}` });
    return null;
  });
}

/** The key that decrypts secrets in the database. Needed to restore a backup; never part of one. */
export async function revealEncryptionKey() {
  return act(async () => {
    const ctx = await requireInstanceAdmin();
    await logActivity({ userId: ctx.user.id, organizationId: ctx.org.id, action: "instance.reveal-key", message: "Revealed the encryption key" });
    return { key: env.encryptionKey, variable: process.env.SERVE_ENCRYPTION_KEY ? "SERVE_ENCRYPTION_KEY" : "BETTER_AUTH_SECRET" };
  });
}

export async function checkUpdatesNow() {
  return act(async () => {
    await requireInstanceAdmin();
    const check = await checkForUpdates();
    if (check.error) throw new UserError(`Could not check for updates: ${check.error}`);
    return check;
  });
}

export async function setUpdateCheckEnabled(enabled: boolean) {
  return act(async () => {
    await requireInstanceAdmin();
    await updateSettings({ updateCheckEnabled: enabled });
    return null;
  });
}

export async function startSelfUpdate() {
  return act(async () => {
    const ctx = await requireInstanceAdmin();
    if (installMode() !== "compose") throw new UserError("This installation is not managed by Docker Compose. Update it by hand (see the steps on this page).");
    const settings = await getSettings();
    if (!updateAvailable(settings.updateCheck) || !settings.updateCheck?.latest) throw new UserError("No newer version is available.");
    if (settings.updateRun && (settings.updateRun.state === "backing-up" || settings.updateRun.state === "running")) throw new UserError("An update is already running.");
    const run = await beginUpdate(settings.updateCheck.latest);
    await enqueue("instance.update", { to: run.to }, { concurrencyKey: "instance-update" });
    await logActivity({ userId: ctx.user.id, organizationId: ctx.org.id, action: "instance.update", message: `Started the update from ${run.from} to ${run.to}` });
    return null;
  });
}

/** Polled while an update runs: the stored progress plus the update container's output. */
export async function updateStatus() {
  return act(async () => {
    await requireInstanceAdmin();
    const run = (await getSettings()).updateRun;
    const live = run?.state === "running" ? await updaterLogs() : null;
    return { run, live };
  });
}
