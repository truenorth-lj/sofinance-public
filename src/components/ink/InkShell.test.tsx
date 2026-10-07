import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { InkShell } from "./InkShell";

describe("InkShell", () => {
  it("defaults to max-w-5xl so shared InkNav matches Positions / RWA pairs / Use AI", () => {
    const markup = renderToStaticMarkup(createElement(InkShell, null, "content"));
    expect(markup).toContain("max-w-5xl");
    expect(markup).not.toContain("max-w-3xl");
  });

  it("does not put Position performance in a narrower 3xl column", () => {
    const src = readFileSync(resolve("src/app/position-performance/page.tsx"), "utf8");
    expect(src).not.toMatch(/maxWidth=["']3xl["']/);
  });
});
