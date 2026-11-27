import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ISR_REVALIDATE_ROUTE, ISR_WARMUP_PATHS, runIsrWarmup, type IsrWarmupDeps } from "./isr-warmup";

const SECRET = "s".repeat(48);
const BASE = "http://127.0.0.1:8080";

type Answer = { status: number; cache?: string; body?: string } | "network-error";

/** A fake local server: each path answers from its queue (the last answer repeats). Records every request. */
function fakeServer(answers: Record<string, Answer[]>) {
  const calls: { path: string; method: string; authorization: string | null }[] = [];
  const fetchImpl = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    calls.push({ path: url.pathname, method: init?.method ?? "GET", authorization: headers.get("authorization") });
    const queue = answers[url.pathname] ?? [{ status: 404 }];
    const answer = queue.length > 1 ? queue.shift()! : queue[0]!;
    if (answer === "network-error") throw new TypeError("fetch failed");
    return new Response(answer.body ?? "x", {
      status: answer.status,
      headers: answer.cache ? { "x-nextjs-cache": answer.cache } : {},
    });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

function deps(fetchImpl: typeof fetch, overrides: Partial<IsrWarmupDeps> = {}) {
  const lines: string[] = [];
  return {
    lines,
    deps: { baseUrl: BASE, secret: SECRET, fetchImpl, sleep: async () => {}, log: (line: string) => lines.push(line),
      readyTimeoutMs: 5000, renderAttempts: 5, ...overrides } satisfies IsrWarmupDeps,
  };
}

const healthy = { "/api/health": [{ status: 200 }], [ISR_REVALIDATE_ROUTE]: [{ status: 200 }] };

describe("runIsrWarmup", () => {
  it("waits for health, revalidates with the bearer, then renders every path until it is no longer STALE", async () => {
    const server = fakeServer({
      "/api/health": ["network-error", { status: 503 }, { status: 200 }],
      [ISR_REVALIDATE_ROUTE]: [{ status: 200 }],
      "/": [{ status: 200, cache: "STALE", body: "thin" }, { status: 200, cache: "HIT", body: "full page" }],
      "/sitemap.xml": [{ status: 200, cache: "MISS", body: "<urlset/>" }],
    });
    const run = deps(server.fetchImpl);
    expect(await runIsrWarmup(run.deps)).toBe("warmed");
    expect(server.calls.filter((c) => c.path === "/api/health")).toHaveLength(3);
    const revalidate = server.calls.filter((c) => c.path === ISR_REVALIDATE_ROUTE);
    expect(revalidate).toEqual([{ path: ISR_REVALIDATE_ROUTE, method: "POST", authorization: `Bearer ${SECRET}` }]);
    expect(server.calls.filter((c) => c.path === "/")).toHaveLength(2);
    expect(run.lines).toContain(`isr-warmup ${JSON.stringify({ path: "/", status: 200, cache: "HIT", bytes: 9 })}`);
    expect(run.lines.join("\n")).not.toContain(SECRET);
  });

  it("is skipped without a usable CRON_SECRET and calls nothing", async () => {
    for (const secret of [undefined, "", "short"]) {
      const server = fakeServer(healthy);
      const run = deps(server.fetchImpl, { secret });
      expect(await runIsrWarmup(run.deps)).toBe("skipped");
      expect(server.calls).toEqual([]);
    }
  });

  it("fails without revalidating when the server never becomes healthy", async () => {
    const server = fakeServer({ "/api/health": [{ status: 503 }] });
    const run = deps(server.fetchImpl, { readyTimeoutMs: 3000 });
    expect(await runIsrWarmup(run.deps)).toBe("failed");
    expect(server.calls.map((c) => c.path)).toEqual(["/api/health", "/api/health", "/api/health"]);
  });

  it("fails and renders nothing when the revalidate route refuses", async () => {
    const server = fakeServer({ "/api/health": [{ status: 200 }], [ISR_REVALIDATE_ROUTE]: [{ status: 401 }] });
    const run = deps(server.fetchImpl);
    expect(await runIsrWarmup(run.deps)).toBe("failed");
    expect(run.lines).toEqual(["isr-warmup failed: revalidate answered 401"]);
    expect(server.calls.some((c) => ISR_WARMUP_PATHS.includes(c.path as never))).toBe(false);
  });

  it("reports failed when a path is still STALE after every attempt", async () => {
    const server = fakeServer({ ...healthy, "/": [{ status: 200, cache: "STALE" }], "/sitemap.xml": [{ status: 200 }] });
    const run = deps(server.fetchImpl);
    expect(await runIsrWarmup(run.deps)).toBe("failed");
    expect(server.calls.filter((c) => c.path === "/")).toHaveLength(5);
  });
});

/** `src/app/<segments>/(page.tsx|sitemap.ts|...)` → URL path, for static routes. */
function routePath(file: string): string {
  const rel = relative(resolve("src/app"), file).split("/").filter((s) => !/^\(.*\)$/.test(s));
  const name = rel.pop()!;
  const base = `/${rel.join("/")}`.replace(/\/$/, "") || "/";
  if (name === "sitemap.ts") return base === "/" ? "/sitemap.xml" : `${base}/sitemap.xml`;
  return base;
}

function appFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return appFiles(path);
    return /^(page\.tsx|route\.ts|sitemap\.ts)$/.test(name) ? [path] : [];
  });
}

describe("ISR_WARMUP_PATHS", () => {
  it("lists exactly the app's static ISR routes (revalidate, no dynamic segment, no request-dependent input)", () => {
    const isr = appFiles(resolve("src/app")).filter((file) => {
      const source = readFileSync(file, "utf8");
      return /^export const revalidate = \d+/m.test(source) && !file.includes("[")
        && !/searchParams|request\.url/.test(source);
    }).map(routePath).sort();
    expect([...ISR_WARMUP_PATHS].sort()).toEqual(isr);
  });

  it("stays dependency-free for Node type stripping in the Railway entry", () => {
    expect(readFileSync(resolve("src/lib/isr-warmup.ts"), "utf8")).not.toMatch(/^\s*import\s/m);
  });
});
