import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const files = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name);
  return statSync(path).isDirectory() ? files(path) : /\.tsx?$/.test(name) && !/\.test\./.test(name) ? [path] : [];
});

describe("public docs copy", () => {
  const docs = files(resolve("src/app/docs"));

  it("makes no repository or open-source claim", () => {
    for (const file of docs) {
      expect(readFileSync(file, "utf8"), file).not.toMatch(/public (product )?repositor|open[- ]source|github\.com|shipping in public/i);
    }
  });

  it("fees page states rates and when they apply, never a fee wallet or address", () => {
    const fees = readFileSync(resolve("src/app/docs/fees/page.tsx"), "utf8");
    expect(fees).not.toMatch(/fee wallet|token account|\b0x[0-9a-fA-F]{6,}|[1-9A-HJ-NP-Za-km-z]{32,44}/);
    expect(fees).toContain("On Solana");
    expect(fees).toContain("On Robinhood Chain");
  });
});
