import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(import.meta.dirname, "..", "..");
const NEW_CONNECTION = /\bnew\s+Connection\s*\(/;
const RPC_URL = /https:\/\/api\.mainnet-beta\.solana\.com|https:\/\/rpc\.solami\.dev/;

function allowed(rel: string): boolean {
  return rel === "lib/rpc.test.ts" || rel.startsWith("lib/rpc/");
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

describe("rpc access guard", () => {
  it("keeps new Connection( and Solana RPC URL literals inside src/lib/rpc", () => {
    const violations: string[] = [];
    for (const file of walk(SRC)) {
      const rel = relative(SRC, file).replaceAll("\\", "/");
      if (allowed(rel)) continue;
      const text = readFileSync(file, "utf8");
      if (NEW_CONNECTION.test(text)) violations.push(`${rel}: new Connection(`);
      if (RPC_URL.test(text)) violations.push(`${rel}: RPC URL literal`);
    }
    expect(violations).toEqual([]);
  });
});
