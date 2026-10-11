// Builds (when needed) and serves the app from the repo root on E2E_PORT, with CI-only dummy configuration.
// Variant "appkit" (default, = production's provider) inlines a dummy Reown project id; "adapter" builds without one
// (wallet-adapter provider). The variant is inlined at build time, so a stamp decides when a rebuild is needed.
import { spawnSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const stampFile = path.resolve(here, "../.e2e-build-stamp");
const variant = process.env.E2E_PROVIDER === "adapter" ? "adapter" : "appkit";
const port = process.env.E2E_PORT ?? "3217";
const secret = process.env.E2E_SIGNING_SECRET ?? "e2e-ci-only-not-a-secret";

const git = (...args) => spawnSync("git", args, { cwd: root, encoding: "utf8" }).stdout ?? "";
const stamp = createHash("sha256").update(variant).update(git("rev-parse", "HEAD")).update(git("diff", "HEAD")).digest("hex");

const buildEnv = { ...process.env, JUPITER_API_KEY: secret };
delete buildEnv.NEXT_PUBLIC_REOWN_PROJECT_ID;
if (variant === "appkit") buildEnv.NEXT_PUBLIC_REOWN_PROJECT_ID = "00000000000000000000000000000000";

const upToDate = process.env.E2E_SKIP_BUILD === "1" ||
  (existsSync(stampFile) && readFileSync(stampFile, "utf8") === stamp && existsSync(path.join(root, ".next/BUILD_ID")));
if (!upToDate) {
  console.error(`[e2e] building app (${variant})...`);
  const build = spawnSync(process.execPath, [path.join(root, "node_modules/next/dist/bin/next"), "build", "--webpack"], { cwd: root, env: buildEnv, stdio: ["ignore", "ignore", "inherit"] });
  if (build.status !== 0) process.exit(build.status ?? 1);
  writeFileSync(stampFile, stamp);
}
console.error(`[e2e] serving ${variant} build on :${port}`);
// Run next's own entry with this node (no npx wrapper): the SIGTERM Playwright sends on shutdown then reaches the server itself.
const nextBin = path.join(root, "node_modules/next/dist/bin/next");
const server = spawn(process.execPath, [nextBin, "start", "-p", port], { cwd: root, env: buildEnv, stdio: ["ignore", "inherit", "inherit"] });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { server.kill(signal); });
server.on("exit", (code) => process.exit(code ?? 0));
