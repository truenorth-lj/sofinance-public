// Verify the standalone bundle boots and enforces auth without workspace files,
// real credentials, a database, or an external network. Always remove our container.
import { execFileSync } from "node:child_process";
import { setTimeout } from "node:timers/promises";

const image = process.argv[2];
if (!image) throw new Error("Usage: node scripts/smoke-rwa-container.mjs <image>");
const docker = (...args) => execFileSync("docker", args, { encoding: "utf8", timeout: 30_000 });
let container;
try {
  container = docker("run", "--detach", "--network", "none",
    "--env", "DATABASE_URL=postgres://sofinance:dummy@127.0.0.1:1/sofinance",
    "--env", "CRON_SECRET=ci-only-not-a-secret-at-least-32-characters",
    image).trim();
  let ready = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    if (docker("logs", container).includes("rwa-data-service ready")) { ready = true; break; }
    if (docker("inspect", "--format", "{{.State.Running}}", container).trim() !== "true") break;
    await setTimeout(500);
  }
  if (!ready) throw new Error("Standalone RWA container did not become ready");
  docker("exec", container, "node", "--input-type=module", "-e", `
    import assert from 'node:assert/strict';
    import { existsSync } from 'node:fs';
    assert.equal(existsSync('/app/node_modules'), false);
    assert.equal(existsSync('/app/packages'), false);
    const response = await fetch('http://127.0.0.1:3000/v1/rwa', {
      method: 'POST', body: '{}', signal: AbortSignal.timeout(5000)
    });
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), {code: 'UNAUTHORIZED'});
  `);
  console.log("Standalone RWA container: boot and auth smoke passed (network disabled)");
} finally {
  if (container) docker("rm", "--force", container);
}
