import { utils } from "ssh2";
import { fingerprint } from "./ssh";

/**
 * New ed25519 key pair from ssh2. About 1 in 200 of its keys is malformed (a key that starts with
 * a zero byte is written one byte short), and neither half then loads anywhere: make another.
 */
export function ed25519Pair(comment?: string) {
  for (let i = 0; i < 20; i++) {
    const pair = utils.generateKeyPairSync("ed25519", comment ? { comment } : undefined);
    const pub = utils.parseKey(pair.public);
    const priv = utils.parseKey(pair.private);
    if (pub instanceof Error || priv instanceof Error || Array.isArray(pub) || Array.isArray(priv)) continue;
    if (priv.getPublicSSH().equals(pub.getPublicSSH())) return pair;
  }
  throw new Error("Could not make an SSH key. Try again.");
}

/** New ed25519 key pair in OpenSSH format. */
export function generateKeyPair(comment: string) {
  const pair = ed25519Pair(comment);
  const publicKey = pair.public.trim();
  return { privateKey: pair.private, publicKey, fingerprint: fingerprint(publicKey) };
}

/** Validates a pasted private key and derives its public key. */
export function parsePrivateKey(pem: string, comment = "serve") {
  const parsed = utils.parseKey(pem.trim() + "\n");
  if (parsed instanceof Error) {
    if (/encrypted|passphrase/i.test(parsed.message)) throw new Error("Keys protected by a passphrase are not supported. Remove the passphrase first.");
    throw new Error("This is not a valid private key. Paste an OpenSSH or PEM private key.");
  }
  const key = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!key.isPrivateKey()) throw new Error("This is a public key. Paste the private key.");
  const publicKey = `${key.type} ${key.getPublicSSH().toString("base64")} ${comment}`;
  return { privateKey: pem.trim() + "\n", publicKey, fingerprint: fingerprint(publicKey) };
}
