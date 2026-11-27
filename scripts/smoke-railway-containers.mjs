// CI smoke for the Railway images (docs/deploy/railway.md), with no real credentials and no external network:
// - web: boots `next start` on 0.0.0.0:$PORT and answers GET /api/health through a published port (Docker forwards
//   to the container's own interface, so a 127.0.0.1-only bind would fail);
// - rwa-refresh-cron: runs the dependency-free entry and exits 1 on missing configuration without printing secrets.
// Always removes its containers.
import { execFileSync, spawnSync } from "node:child_process";
import { setTimeout } from "node:timers/promises";

const [webImage, cronImage] = process.argv.slice(2);
if (!webImage || !cronImage) throw new Error("Usage: node scripts/smoke-railway-containers.mjs <web-image> <cron-image>");
const docker = (...args) => execFileSync("docker", args, { encoding: "utf8", timeout: 60_000 });

let web;
try {
  web = docker("run", "--detach", "--env", "PORT=8123", "--publish", "127.0.0.1:8123:8123", webImage).trim();
  let health;
  for (let attempt = 0; attempt < 60 && !health; attempt++) {
    if (docker("inspect", "--format", "{{.State.Running}}", web).trim() !== "true") break;
    try {
      const response = await fetch("http://127.0.0.1:8123/api/health", { signal: AbortSignal.timeout(2000) });
      if (response.ok) health = { status: response.status, body: await response.json(), cache: response.headers.get("cache-control") };
    } catch { /* not listening yet */ }
    if (!health) await setTimeout(1000);
  }
  if (!health) throw new Error(`web container did not answer /api/health\n${docker("logs", web)}`);
  if (JSON.stringify(health.body) !== '{"status":"ok"}' || health.cache !== "no-store")
    throw new Error(`unexpected /api/health answer: ${JSON.stringify(health)}`);
  console.log("Railway web container: next start on 0.0.0.0:$PORT, /api/health ok");
} finally {
  if (web) docker("rm", "--force", web);
}

const cron = spawnSync("docker", ["run", "--rm", "--network", "none", "--env", "CRON_SECRET=ci-only-not-a-secret-at-least-32-characters", cronImage],
  { encoding: "utf8", timeout: 60_000 });
const output = `${cron.stdout}${cron.stderr}`;
if (cron.status !== 1 || !output.includes("rwa-refresh-cron config error: RWA refresh URL is not configured"))
  throw new Error(`cron container: expected exit 1 with a config error, got ${cron.status}\n${output}`);
if (output.includes("ci-only-not-a-secret")) throw new Error("cron container printed CRON_SECRET");
console.log("Railway cron container: dependency-free entry runs and fails closed without configuration");
