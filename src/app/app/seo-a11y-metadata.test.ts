import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(resolve(path), "utf8");

describe("wallet-only and AI metadata", () => {
  it("noindexes /app/portfolio, /app/portfolio/recovery, and the full /app/sign/* set", () => {
    const portfolio = read("src/app/app/portfolio/layout.tsx");
    const sign = read("src/app/app/sign/layout.tsx");
    expect(portfolio).toContain("robots: { index: false, follow: true }");
    expect(sign).toContain("robots: { index: false, follow: true }");
    // The only sign route is /app/sign/[token]; the segment layout covers it.
    expect(readFileSync(resolve("src/app/app/sign/[token]/page.tsx"), "utf8")).toContain("export default function SignPage");
  });

  it("gives /app/ai a real title, description, and canonical", () => {
    const layout = read("src/app/app/ai/layout.tsx");
    expect(layout).toContain('title: "AI agents (MCP)"');
    expect(layout).toContain("pageMetadata");
    expect(layout).toContain("path: APP_ROUTES.ai");
    expect(layout).toContain("description:");
  });
});

describe("header connect label", () => {
  it("keeps Connect wallet on sm+ and shortens to Connect below sm, with nowrap", () => {
    const src = read("src/components/homepage-wallet-island.tsx");
    expect(src).toContain("whitespace-nowrap");
    expect(src).toContain('<>Connect<span className="hidden sm:inline"> wallet</span></>');
  });
});
