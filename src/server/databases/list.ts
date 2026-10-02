import type { schema } from "@/server/db";
import { decrypt } from "@/server/crypto";
import { serverOf } from "@/server/servers/context";
import { execCommand } from "@/server/services/exec";
import { databaseContainer } from "./container";
import { databaseCreds } from "./options";
import { parseListing, userScripts, usersSupported } from "./users";

type Service = typeof schema.service.$inferSelect;

/** The databases of a database service's server, without the engine's own. Empty where it has none to list. */
export async function listDatabases(service: Service): Promise<string[]> {
  const cfg = service.database;
  if (!cfg || !usersSupported(cfg)) return [];
  const { docker } = await serverOf(service);
  const container = await databaseContainer(docker, service);
  const password = decrypt(cfg.password);
  const res = await execCommand(container.id, userScripts(cfg.engine, databaseCreds(cfg, password)).list(), { docker, timeoutSeconds: 60 });
  if (res.exitCode !== 0) throw new Error(res.output.replaceAll(password, "***").trim().split("\n").slice(-2).join(" ") || "Could not list the databases.");
  return parseListing(cfg.engine, res.output).databases;
}
