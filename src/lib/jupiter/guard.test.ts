import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(import.meta.dirname, "..", "..");
const JUPITER_HOST = /(?:https:\/\/)?(?:api|lite-api)\.jup\.ag/;

function allowed(rel: string): boolean {
  return rel === "lib/jupiter/guard.test.ts" || rel.startsWith("lib/jupiter/");
}

function walk(dir: string, files: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, files);
    else if (/\.(ts|tsx)$/.test(name)) files.push(path);
  }
  return files;
}

describe("jupiter access guard", () => {
  it("keeps api.jup.ag / lite-api.jup.ag literals inside src/lib/jupiter", () => {
    const violations: string[] = [];
    for (const file of walk(SRC)) {
      const rel = relative(SRC, file).replaceAll("\\", "/");
      if (allowed(rel)) continue;
      const text = readFileSync(file, "utf8");
      if (JUPITER_HOST.test(text)) violations.push(`${rel}: Jupiter host literal`);
    }
    expect(violations).toEqual([]);
  });
});
