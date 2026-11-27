import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/** Every reader of edge geo / client-IP headers must go through src/lib/request-origin. */
const EDGE_HEADER_READ = /headers\.get\(\s*["'](?:cf-ipcountry|cf-connecting-ip|x-vercel-ip-country|x-vercel-forwarded-for|x-real-ip|x-forwarded-for)["']/i;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(?:ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

describe("request-origin is the single source of edge headers", () => {
  it("no other app module reads geo or client-IP headers directly", () => {
    const src = resolve("src");
    const offenders = sourceFiles(src)
      .map((path) => relative(src, path))
      .filter((path) => !path.startsWith("lib/request-origin/"))
      .filter((path) => EDGE_HEADER_READ.test(readFileSync(join(src, path), "utf8")));
    expect(offenders).toEqual([]);
  });
});
