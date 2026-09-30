import { utils } from "ssh2";
import { decrypt, encrypt } from "@/server/crypto";
import { db, schema } from "@/server/db";
import { getSettings } from "@/server/settings";
import { ed25519Pair } from "@/server/servers/keys";

/** The listener's host key, made once. Servers pin its public half, so nobody can pose as Serve. */
export async function tunnelHostKey(retry = true): Promise<{ privateKey: string; publicKey: string }> {
  const settings = await getSettings();
  if (settings.tunnelHostKey) {
    const privateKey = decrypt(settings.tunnelHostKey);
    const parsed = utils.parseKey(privateKey);
    if (!(parsed instanceof Error)) return { privateKey, publicKey: `${parsed.type} ${parsed.getPublicSSH().toString("base64")}` };
  }
  // The web and the worker may both get here first: only one key is kept, and both use that one.
  const pair = ed25519Pair();
  const created = await db
    .insert(schema.setting)
    .values({ key: "tunnelHostKey", value: encrypt(pair.private) as never })
    .onConflictDoNothing()
    .returning({ key: schema.setting.key });
  if (created.length) return { privateKey: pair.private, publicKey: pair.public.split(" ").slice(0, 2).join(" ") };
  if (!retry) throw new Error("The tunnel host key in the settings cannot be read.");
  return tunnelHostKey(false);
}
