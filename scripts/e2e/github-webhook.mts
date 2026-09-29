// Simulates a GitHub App: stores a fake app credential, links a service, sends a signed push.
import "dotenv/config";
import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import { db, schema, sql } from "@/server/db";
import { encrypt } from "@/server/crypto";

const [serviceId] = process.argv.slice(2);
const [service] = await db.select().from(schema.service).where(eq(schema.service.id, serviceId));
const [project] = await db.select().from(schema.project).where(eq(schema.project.id, service.projectId));
const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const credentialId = `ghapp${Date.now().toString(36)}`;
const webhookSecret = crypto.randomBytes(20).toString("hex");
await db.insert(schema.gitCredential).values({
  id: credentialId,
  organizationId: project.organizationId,
  name: "GitHub App · test",
  provider: "github-app",
  publicInfo: "test",
  secret: encrypt(
    JSON.stringify({
      appId: 1,
      slug: "serve-test",
      htmlUrl: "https://github.com/apps/serve-test",
      pem: privateKey.export({ type: "pkcs1", format: "pem" }),
      webhookSecret,
      clientId: "x",
      clientSecret: "y",
      installationId: 99,
      account: "test",
    }),
  ),
});
await db
  .update(schema.service)
  .set({ source: { type: "git", repository: "https://github.com/heroku/node-js-getting-started.git", branch: "main", credentialId } })
  .where(eq(schema.service.id, serviceId));

const send = async (event: string, body: object, secret = webhookSecret) => {
  const raw = JSON.stringify(body);
  const sig = `sha256=${crypto.createHmac("sha256", secret).update(raw).digest("hex")}`;
  const res = await fetch(`http://localhost:3001/api/webhooks/github/${credentialId}`, {
    method: "POST",
    headers: { "x-github-event": event, "x-hub-signature-256": sig },
    body: raw,
  });
  return `${res.status} ${await res.text()}`;
};
console.log("ping:", await send("ping", { zen: "hi" }));
console.log("bad signature:", await send("push", {}, "wrong"));
console.log(
  "push main:",
  await send("push", {
    ref: "refs/heads/main",
    after: "abc",
    head_commit: { id: "abc1234", message: "Update README", author: { name: "Ada" } },
    repository: { full_name: "heroku/node-js-getting-started" },
  }),
);
console.log("push other repo:", await send("push", { ref: "refs/heads/main", repository: { full_name: "someone/else" } }));
console.log("uninstall:", await send("installation", { action: "deleted", installation: { id: 99 } }));
await sql.end();
