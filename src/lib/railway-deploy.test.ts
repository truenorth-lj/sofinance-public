import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { RWA_REFRESH_CRON } from "./rwa-freshness";

/** Keeps the Railway Dockerfiles, the deploy doc and the code in step (docs/deploy/railway.md). */
const read = (path: string) => readFileSync(resolve(path), "utf8");
const webDockerfile = read("railway/web.Dockerfile");
const cronDockerfile = read("railway/rwa-refresh-cron.Dockerfile");
const doc = read("docs/deploy/railway.md");

const buildArgs = new Set([...webDockerfile.matchAll(/^ARG ([A-Z0-9_]+)$/gm)].map((m) => m[1]!));
/** Inlined from VERCEL_ENV in next.config.ts / local screenshot builds only — never set by hand. */
const DERIVED_OR_LOCAL_PUBLIC = new Set(["NEXT_PUBLIC_SOFI_DEPLOY_ENV", "NEXT_PUBLIC_CELEBRATION_PREVIEW"]);

function appSources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return appSources(path);
    return /\.(?:ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

/** Doc table rows `| \`NAME\` | build | ...` → name → build column. */
function documentedEnv(): Map<string, string> {
  const rows = [...doc.matchAll(/^\| `([A-Z0-9_]+)` \| ([^|]*) \|/gm)];
  return new Map(rows.map((m) => [m[1]!, m[2]!.trim()]));
}

describe("railway/web.Dockerfile", () => {
  it("declares every NEXT_PUBLIC_* the app reads as a build ARG (Railway only passes declared ARGs to the build)", () => {
    const sources = [...appSources(resolve("src")), resolve("next.config.ts")].map((p) => readFileSync(p, "utf8")).join("\n");
    const publicNames = new Set([...sources.matchAll(/process\.env(?:\.|\[")(NEXT_PUBLIC_[A-Z0-9_]+)/g)].map((m) => m[1]!));
    const missing = [...publicNames].filter((name) => !DERIVED_OR_LOCAL_PUBLIC.has(name) && !buildArgs.has(name));
    expect(missing).toEqual([]);
  });

  it("documents every build ARG in the env checklist, and marks public/sentry ones as build-time", () => {
    const documented = documentedEnv();
    const builtInRailway = new Set(["RAILWAY_GIT_COMMIT_SHA"]);
    for (const name of buildArgs) {
      if (builtInRailway.has(name)) continue;
      expect(documented.has(name), `${name} missing from docs/deploy/railway.md`).toBe(true);
      if (name.startsWith("NEXT_PUBLIC_")) expect(documented.get(name)).toBe("public");
      if (name.startsWith("SENTRY_") && name !== "SENTRY_DSN") expect(documented.get(name)).toBe("sentry");
    }
  });

  it("passes no server value into the build: only NEXT_PUBLIC_* and the Sentry release names (Railway has no secret mounts)", () => {
    const allowed = new Set(["SENTRY_ORG", "SENTRY_PROJECT", "RAILWAY_GIT_COMMIT_SHA"]);
    expect([...buildArgs].filter((name) => !name.startsWith("NEXT_PUBLIC_") && !allowed.has(name))).toEqual([]);
  });

  it("does not pass Railway-only runtime switches into the build", () => {
    for (const name of ["PORT", "RAILWAY_PROJECT_ID", "SOFINANCE_TRUST_CLOUDFLARE_HEADERS", "VERCEL", "VERCEL_ENV", "VERCEL_URL"])
      expect(buildArgs.has(name), name).toBe(false);
  });

  it("serves next start on 0.0.0.0:$PORT", () => {
    expect(webDockerfile).toMatch(/next start --hostname 0\.0\.0\.0 --port \\"\$\{PORT:-8080\}\\"/);
  });

  it("the documented healthcheck route exists", () => {
    expect(doc).toContain("| Healthcheck path | `/api/health`");
    expect(existsSync(resolve("src/app/api/health/route.ts"))).toBe(true);
  });
});

describe("railway/rwa-refresh-cron.Dockerfile", () => {
  it("documents the same schedule as RWA_REFRESH_CRON (and vercel.json)", () => {
    const documented = /\| Cron schedule \| `([^`]+)`/.exec(doc)?.[1];
    expect(documented).toBe(RWA_REFRESH_CRON);
    expect(cronDockerfile).toContain(`"${RWA_REFRESH_CRON}" UTC`);
  });

  it("copies everything the dependency-free entry needs", () => {
    const entry = read("scripts/rwa-refresh-cron.ts");
    const trigger = read("src/lib/rwa-refresh-trigger.ts");
    expect([...entry.matchAll(/from "([^"]+)"/g)].map((m) => m[1])).toEqual(["../src/lib/rwa-refresh-trigger.ts"]);
    expect(trigger).not.toMatch(/^\s*import\s/m);
    expect(cronDockerfile).toContain("COPY src/lib/rwa-refresh-trigger.ts ./src/lib/rwa-refresh-trigger.ts");
    expect(cronDockerfile).toContain("COPY scripts/rwa-refresh-cron.ts ./scripts/rwa-refresh-cron.ts");
  });
});
