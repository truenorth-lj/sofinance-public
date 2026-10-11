// Proves the wallet key never reaches traces: plants a known throwaway key, records full traces for every hermetic test,
// then searches every file inside every trace.zip (and the HTML report data) for the key in all common encodings.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import bs58 from "bs58";
import nacl from "tweetnacl";

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pair = nacl.sign.keyPair();
const secret = Buffer.from(pair.secretKey);               // 64 bytes (seed + public)
const seed = secret.subarray(0, 32);
const needles = new Map([
  ["secret base58", bs58.encode(secret)], ["seed base58", bs58.encode(seed)],
  ["secret base64", secret.toString("base64")], ["seed base64", seed.toString("base64")],
  ["secret base64url", secret.toString("base64url")], ["seed base64url", seed.toString("base64url")],
  ["secret hex", secret.toString("hex")], ["seed hex", seed.toString("hex")],
  ["seed as JSON array", [...seed].join(",")],
]);

rmSync(path.join(here, "test-results"), { recursive: true, force: true });
const run = spawnSync(process.execPath, ["node_modules/@playwright/test/cli.js", "test", "--project=hermetic", "--retries=0", "--trace=on", "--reporter=dot"],
  { cwd: here, env: { ...process.env, E2E_TEST_KEY_B58: bs58.encode(secret) }, encoding: "utf8" });
console.log(run.stdout.split("\n").filter((l) => /passed|failed/.test(l)).join(" "));

const unzip = (zip) => spawnSync("unzip", ["-p", zip], { maxBuffer: 1 << 30 });
let traces = 0, bytes = 0, hits = [];
const walk = (dir) => readdirSync(dir).flatMap((name) => { const p = path.join(dir, name); return statSync(p).isDirectory() ? walk(p) : [p]; });
for (const file of walk(path.join(here, "test-results")).filter((f) => f.endsWith(".zip"))) {
  const content = unzip(file).stdout; traces++; bytes += content.length;
  const text = content.toString("latin1");
  for (const [label, needle] of needles) if (text.includes(needle)) hits.push(`${label} in ${path.relative(here, file)}`);
  // sanity: the PUBLIC key must be present (proves the scan really read page data)
  if (!text.includes(bs58.encode(pair.publicKey)) && !text.includes("E2E Test Wallet")) hits.push(`scan sanity failed for ${file}`);
}
const report = path.join(here, "playwright-report");
if (existsSync(report)) for (const file of walk(report)) {
  const text = readFileSync(file).toString("latin1");
  for (const [label, needle] of needles) if (text.includes(needle)) hits.push(`${label} in ${path.relative(here, file)}`);
}
console.log(`scanned ${traces} traces (${(bytes / 1e6).toFixed(1)} MB uncompressed) for ${needles.size} encodings of the secret key`);
console.log(hits.length ? `LEAK: ${hits.join("; ")}` : "no occurrence of the wallet secret key");
process.exit(hits.length || run.status ? 1 : 0);
