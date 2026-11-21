import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { root, variant, buildEnv } from "./build-app.mjs";

const port = process.env.E2E_PORT ?? "3217";
console.error(`[e2e] serving ${variant} build on :${port}`);
// Run next's own entry with this node (no npx wrapper): the SIGTERM Playwright sends on shutdown then reaches the server itself.
const nextBin = path.join(root, "node_modules/next/dist/bin/next");
// Hermetic egress guard: the server refuses every fetch to real Jupiter and records it (scripts/hermetic-egress-guard.mjs).
// Fresh ledger per server; the guard fills in the "loaded" marker, which the global teardown requires.
const ledger = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../.server-egress-blocked.jsonl");
writeFileSync(ledger, "");
writeFileSync(`${ledger}.loaded`, "");
const guard = new URL("./hermetic-egress-guard.mjs", import.meta.url).href;
const server = spawn(process.execPath, ["--import", guard, nextBin, "start", "-p", port], { cwd: root, env: buildEnv, stdio: ["ignore", "inherit", "inherit"] });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { server.kill(signal); });
server.on("exit", (code) => process.exit(code ?? 0));
