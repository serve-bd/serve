import { generateKeyPairSync } from "node:crypto";

/** A WireGuard key pair (base64, as `wg` prints them). */
export function generateMeshKeys() {
  const { publicKey, privateKey } = generateKeyPairSync("x25519");
  const b64 = (v: string | undefined) => Buffer.from(v ?? "", "base64url").toString("base64");
  return { publicKey: b64(publicKey.export({ format: "jwk" }).x), privateKey: b64(privateKey.export({ format: "jwk" }).d) };
}
