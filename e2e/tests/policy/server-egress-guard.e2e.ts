import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { readBlockedEgress } from "../../support/server-egress";

// The guard the hermetic server is started with (scripts/serve-app.mjs), exercised in its own Node process.
const guard = new URL("../../scripts/hermetic-egress-guard.mjs", import.meta.url).href;

const probe = `
import { createServer } from "node:http";
const server = createServer((_req, res) => res.end("local ok"));
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const results = {};
for (const [name, input] of Object.entries({
  apiSearch: "https://api.jup.ag/tokens/v2/search?query=SNDK&apiKey=PROBE-NOT-A-KEY",
  litePrice: new URL("https://lite-api.jup.ag/price/v3?ids=x"),
  request: new Request("https://api.jup.ag/swap/v1/quote"),
  local: "http://127.0.0.1:" + server.address().port + "/ok",
})) {
  try { results[name] = { ok: true, body: await (await fetch(input)).text() }; }
  catch (error) { results[name] = { ok: false, message: error.message }; }
}
server.close();
console.log(JSON.stringify(results));
`;

test("the hermetic server's egress guard refuses real Jupiter loudly and lets everything else through", () => {
  const ledger = path.join(mkdtempSync(path.join(tmpdir(), "egress-")), "ledger.jsonl");
  const run = spawnSync(process.execPath, ["--import", guard, "--input-type=module", "-e", probe],
    { env: { ...process.env, E2E_EGRESS_LEDGER: ledger }, encoding: "utf8", timeout: 20_000 });
  expect(run.status, run.stderr).toBe(0);
  const results = JSON.parse(run.stdout.trim().split("\n").at(-1) ?? "{}") as Record<string, { ok: boolean; message?: string; body?: string }>;

  expect(results.apiSearch).toEqual({ ok: false, message: expect.stringMatching(/^\[e2e hermetic\] blocked server-side fetch to real Jupiter: api\.jup\.ag\/tokens\/v2\/search\./) });
  expect(results.litePrice).toEqual({ ok: false, message: expect.stringContaining("lite-api.jup.ag/price/v3") });
  expect(results.request).toEqual({ ok: false, message: expect.stringContaining("api.jup.ag/swap/v1/quote") });
  expect(results.local).toEqual({ ok: true, body: "local ok" });            // non-Jupiter fetches are untouched

  expect(run.stderr).toContain("[e2e hermetic] blocked server-side fetch to real Jupiter: api.jup.ag/tokens/v2/search");
  expect(readBlockedEgress(ledger).map(({ host, path }) => `${host}${path}`))
    .toEqual(["api.jup.ag/tokens/v2/search", "lite-api.jup.ag/price/v3", "api.jup.ag/swap/v1/quote"]);
  expect(readFileSync(ledger, "utf8") + run.stderr + run.stdout).not.toContain("PROBE-NOT-A-KEY");   // query strings are never recorded
  expect(readFileSync(`${ledger}.loaded`, "utf8")).toBe(String(run.pid));
});
