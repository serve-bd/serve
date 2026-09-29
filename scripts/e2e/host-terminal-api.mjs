// Host terminal API test (no UI): open a session, type a command, read SSE output, close.
// Usage: BASE=http://localhost:3001 node scripts/e2e/host-terminal-api.mjs <serverId>
import fs from "node:fs";

const base = process.env.BASE ?? "http://localhost:3001";
const serverId = process.argv[2] ?? "local";
const state = JSON.parse(fs.readFileSync(`/tmp/claude-1000/e2e-state-${new URL(base).port}.json`, "utf8"));
const cookie = state.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
const api = `${base}/api/servers/${serverId}/terminal`;

const open = await fetch(api, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ cols: 100, rows: 30 }) });
const body = await open.json();
if (!open.ok) throw new Error(`open failed ${open.status}: ${JSON.stringify(body)}`);
console.log("opened", body);
const url = `${api}/${body.id}`;

const res = await fetch(url, { headers: { cookie, accept: "text/event-stream" } });
const reader = res.body.getReader();
const decoder = new TextDecoder();
let screen = "";
let buffer = "";
const read = async (re, ms = 20000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (re.test(screen)) return screen;
    const chunk = await Promise.race([reader.read(), new Promise((r) => setTimeout(() => r({ timeout: true }), 500))]);
    if (chunk.timeout) continue;
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    const events = buffer.split("\n\n");
    buffer = events.pop();
    for (const e of events) {
      const data = e.split("\n").find((l) => l.startsWith("data: "));
      if (data && !e.includes("event: exit")) screen += Buffer.from(data.slice(6), "base64").toString("utf8");
      if (e.includes("event: exit")) screen += "\n[exit]";
    }
  }
  throw new Error(`timed out waiting for ${re}; screen:\n${screen.slice(-800)}`);
};
const send = (data) => fetch(url, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ type: "input", data }) });

await read(/[#$]\s*(\x1b\[6n)?$/m);
await fetch(url, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ type: "resize", cols: 120, rows: 40 }) });
await send("echo H=$(hostname) U=$(id -u) S=$(stty size)\n");
const out = await read(/H=\S+ U=\d+ S=\d+ \d+/);
console.log(out.match(/H=\S+ U=\d+ S=\d+ \d+/)[0]);
await send("exit\n");
await read(/\[exit\]/);
console.log("exit ok");
const gone = await fetch(url, { headers: { cookie } });
console.log("after exit GET:", gone.status);
