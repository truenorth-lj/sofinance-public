// Builds (when needed) the production app with CI-only dummy configuration.
// Imported by serve-app.mjs so build:app and browser tests use identical configuration.
// Variant "appkit" (default, = production's provider) inlines a dummy Reown project id; "adapter" builds without one
// (wallet-adapter provider). The variant is inlined at build time, so a stamp decides when a rebuild is needed.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const root = path.resolve(here, "../..");
const stampFile = path.resolve(here, "../.e2e-build-stamp");
export const variant = process.env.E2E_PROVIDER === "adapter" ? "adapter" : "appkit";
const secret = process.env.E2E_SIGNING_SECRET ?? "e2e-ci-only-not-a-secret";

const git = (...args) => spawnSync("git", args, { cwd: root, encoding: "utf8" }).stdout ?? "";
// Include new source files too: a workspace package or helper may not be staged yet.
const fingerprint = createHash("sha256").update(variant).update(git("rev-parse", "HEAD"));
const sources = git("ls-files", "--cached", "--others", "--exclude-standard", "-z").split("\0").filter(Boolean).sort();
for (const source of sources) {
  const file = path.join(root, source);
  fingerprint.update(source).update("\0");
  fingerprint.update(existsSync(file) ? readFileSync(file) : "[deleted]").update("\0");
}
const stamp = fingerprint.digest("hex");

export const buildEnv = { ...process.env, JUPITER_API_KEY: secret };
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
