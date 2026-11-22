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
import http from "node:http";
import https from "node:https";
const server = createServer((_req, res) => res.end("local ok"));
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const results = {};
for (const [name, input] of Object.entries({
  apiSearch: "https://api.jup.ag/tokens/v2/search?query=SNDK&apiKey=PROBE-NOT-A-KEY",
  litePrice: new URL("https://lite-api.jup.ag/price/v3?ids=x"),
  request: new Request("https://api.jup.ag/swap/v1/quote"),
  otherHost: "https://example.invalid/v2/THISISALONGAPIKEYVALUEABC123456/path?apiKey=PROBE-NOT-A-KEY",
  local: "http://127.0.0.1:" + server.address().port + "/ok?x=SECRET",
})) {
  try { results[name] = { ok: true, body: await (await fetch(input)).text() }; }
  catch (error) { results[name] = { ok: false, message: error.message }; }
}
try {
  await new Promise((resolve, reject) => {
    const req = http.request({ hostname: "example.invalid", path: "/rpc?key=PROBE-NOT-A-KEY", method: "GET" }, (res) => { res.resume(); resolve(); });
    req.on("error", reject);
    req.end();
  });
  results.http = { ok: true };
} catch (error) { results.http = { ok: false, message: error.message }; }
try {
  await new Promise((resolve, reject) => {
    const req = https.request({ hostname: "example.invalid", path: "/secure?key=PROBE-NOT-A-KEY", method: "GET" }, (res) => { res.resume(); resolve(); });
    req.on("error", reject);
    req.end();
  });
  results.https = { ok: true };
} catch (error) { results.https = { ok: false, message: error.message }; }
try {
  new WebSocket("wss://example.invalid/ws?token=PROBE-NOT-A-KEY");
  results.ws = { ok: true };
} catch (error) { results.ws = { ok: false, message: error.message }; }
server.close();
console.log(JSON.stringify(results));
`;

test("the hermetic server's egress guard refuses every non-local host and lets only loopback through", () => {
  const ledger = path.join(mkdtempSync(path.join(tmpdir(), "egress-")), "ledger.jsonl");
  const run = spawnSync(process.execPath, ["--import", guard, "--input-type=module", "-e", probe],
    { env: { ...process.env, E2E_EGRESS_LEDGER: ledger }, encoding: "utf8", timeout: 20_000 });
  expect(run.status, run.stderr).toBe(0);
  const results = JSON.parse(run.stdout.trim().split("\n").at(-1) ?? "{}") as Record<string, { ok: boolean; message?: string; body?: string }>;

  expect(results.apiSearch).toEqual({ ok: false, message: expect.stringMatching(/^\[e2e hermetic\] blocked server-side fetch to api\.jup\.ag\/tokens\/v2\/search\./) });
  expect(results.litePrice).toEqual({ ok: false, message: expect.stringContaining("lite-api.jup.ag/price/v3") });
  expect(results.request).toEqual({ ok: false, message: expect.stringContaining("api.jup.ag/swap/v1/quote") });
  expect(results.otherHost).toEqual({ ok: false, message: expect.stringContaining("example.invalid/v2/…/path") });
  expect(results.local).toEqual({ ok: true, body: "local ok" });
  expect(results.http).toEqual({ ok: false, message: expect.stringContaining("example.invalid/rpc") });
  expect(results.https).toEqual({ ok: false, message: expect.stringContaining("example.invalid/secure") });
  expect(results.ws).toEqual({ ok: false, message: expect.stringContaining("example.invalid/ws") });

  expect(run.stderr).toContain("[e2e hermetic] blocked server-side fetch to api.jup.ag/tokens/v2/search");
  expect(readBlockedEgress(ledger).map(({ host, path, via }) => `${via}:${host}${path}`)).toEqual([
    "fetch:api.jup.ag/tokens/v2/search",
    "fetch:lite-api.jup.ag/price/v3",
    "fetch:api.jup.ag/swap/v1/quote",
    "fetch:example.invalid/v2/…/path",
    "http.request:example.invalid/rpc",
    "https.request:example.invalid/secure",
    "WebSocket:example.invalid/ws",
  ]);
  const transcript = readFileSync(ledger, "utf8") + run.stderr + run.stdout;
  expect(transcript).not.toContain("PROBE-NOT-A-KEY");
  expect(transcript).not.toContain("SECRET");
  expect(transcript).not.toContain("THISISALONGAPIKEYVALUEABC123456");
  expect(readFileSync(`${ledger}.loaded`, "utf8")).toBe(String(run.pid));
});
