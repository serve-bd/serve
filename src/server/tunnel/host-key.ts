import { utils } from "ssh2";
import { decrypt, encrypt } from "@/server/crypto";
import { getSettings, updateSettings } from "@/server/settings";

/** The listener's host key, made once. Servers pin its public half, so nobody can pose as Serve. */
export async function tunnelHostKey(): Promise<{ privateKey: string; publicKey: string }> {
  const settings = await getSettings();
  if (settings.tunnelHostKey) {
    const privateKey = decrypt(settings.tunnelHostKey);
    const parsed = utils.parseKey(privateKey);
    if (!(parsed instanceof Error)) return { privateKey, publicKey: `${parsed.type} ${parsed.getPublicSSH().toString("base64")}` };
  }
  const pair = utils.generateKeyPairSync("ed25519");
  await updateSettings({ tunnelHostKey: encrypt(pair.private) });
  return { privateKey: pair.private, publicKey: pair.public.split(" ").slice(0, 2).join(" ") };
}
