// Mutation check for the safety nets the suite claims to guard: break one guard at a time in the app source, rebuild,
// run the hermetic suite, and require at least one failing test. The source file is always restored.
// usage: node scripts/mutation-check.mjs   (needs a clean working tree for the two mutated files)
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PAGE = "src/app/app/sign/[token]/page.tsx";
const TOKEN = "src/lib/pending-sign-token.ts";
// kind: "kill" = the suite must fail; "equivalent" = documented as not observable through the UI (the run must stay green,
// and is reported so a future change that makes it observable shows up as an unexpected kill).
const mutants = [
  ["wallet-content guard removed entirely", PAGE, "if (\n        signedMessage.length !== originalMessage.length ||\n        signedMessage.some((byte, index) => byte !== originalMessage[index])\n      ) {", "if (false && (signedMessage.length !== originalMessage.length || signedMessage.some((byte, index) => byte !== originalMessage[index]))) {", "kill"],
  ["wallet-content guard: byte compare disabled (same-length tweak must be caught)", PAGE, "signedMessage.some((byte, index) => byte !== originalMessage[index])", "false", "kill"],
  ["wallet-content guard: length compare disabled", PAGE, "signedMessage.length !== originalMessage.length ||", "false && signedMessage.length !== originalMessage.length ||", "equivalent"],
  ["wrong-wallet status removed", PAGE, "if (payload && wallet && wallet !== payload.wallet) return \"wallet-mismatch\";", "if (payload && wallet && wallet !== payload.wallet && Date.now() < 0) return \"wallet-mismatch\";", "kill"],
  ["wrong-wallet re-check inside handleSign removed (defence in depth, not reachable from the UI)", PAGE, "if (!payload || !wallet || wallet !== payload.wallet) return;", "if (!payload || !wallet) return;", "equivalent"],
  ["payer-mismatch guard removed", PAGE, "if (unsigned.message.staticAccountKeys[0]?.toBase58() !== wallet) {", "if (false) {", "kill"],
  ["response signature check removed", PAGE, "if (result.signature !== txSignature) {", "if (false) {", "kill"],
  ["NFT-mint partial-signature check removed", PAGE, "(!signed.signatures[1] || signed.signatures[1].every((byte) => byte === 0))", "false", "kill"],
  ["all-zero wallet signature check removed", PAGE, "if (!signatureBytes || signatureBytes.every((byte) => byte === 0)) {", "if (!signatureBytes) {", "kill"],
  ["sent:false retry hint removed", PAGE, "result.sent === false ? notSentRetryMessage(reason) : reason", "result.sent === false && false ? notSentRetryMessage(reason) : reason", "kill"],
  ["token expiry check removed (server)", TOKEN, "if (Date.now() >= payload.expiresAt) {", "if (false) {", "kill"],
  ["token HMAC check bypassed (server)", TOKEN, "function hmacVerify(data: string, signature: string, secret: string): boolean {", "function hmacVerify(data: string, signature: string, secret: string): boolean {\n  return true;", "kill"],
];

let ok = 0;
const rows = [];
for (const [name, file, from, to, kind] of mutants) {
  const abs = path.join(root, file);
  const original = readFileSync(abs, "utf8");
  if (!original.includes(from)) { rows.push(`PATTERN NOT FOUND  ${name}`); continue; }
  writeFileSync(abs, original.replace(from, to));
  try {
    const run = spawnSync(process.execPath, ["node_modules/@playwright/test/cli.js", "test", "--project=hermetic", "--retries=0", "--reporter=dot"],
      { cwd: path.join(root, "e2e"), env: { ...process.env, CI: "1" }, encoding: "utf8" });
    const failedLine = (run.stdout.split("\n").find((line) => /\d+ failed/.test(line)) ?? "").trim();
    const green = run.status === 0;
    const verdict = green ? "SURVIVED" : failedLine ? "KILLED  " : "ERROR   (build/server failure, not a kill)";
    const expected = (kind === "kill" && verdict === "KILLED  ") || (kind === "equivalent" && green);
    if (expected) ok++;
    rows.push(`${verdict} ${expected ? "as expected" : "UNEXPECTED"} [${kind}] ${name}  ${failedLine}`);
  } finally {
    writeFileSync(abs, original);
  }
}
console.log(rows.join("\n"));
console.log(`${ok}/${mutants.length} mutants behaved as expected`);
process.exit(ok === mutants.length ? 0 : 1);
