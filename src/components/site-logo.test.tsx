import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { SiteLogo } from "./site-logo";

describe("SiteLogo", () => {
  it("renders the cream squircle H mark and wordmark at 36px, with shrink-0 and no lemon capsule", () => {
    const html = renderToStaticMarkup(createElement(SiteLogo));
    expect(html).toContain('href="/"');
    expect(html).toContain('src="/navbar-mark-squircle-cream.svg"');
    expect(html).toContain('width="36"');
    expect(html).toContain('height="36"');
    expect(html).toContain("h-9 w-9 max-w-none shrink-0 object-contain");
    expect(html).toContain("flex h-9 w-9 shrink-0 items-center justify-center overflow-visible");
    expect(html).toContain("flex shrink-0 items-center gap-2.5");
    expect(html).toContain("font-display");
    expect(html).toContain("text-[20px]");
    expect(html).toContain("font-bold");
    expect(html).toContain("text-cream");
    expect(html).toContain("SoFinance");
    expect(html).not.toContain("bg-lemon");
    expect(html).not.toContain("pl-[7px]");
    expect(html).not.toContain("text-lemon");
    expect(html).not.toContain("BrandMark");
    expect(html).not.toContain('preserveAspectRatio="none"');
  });

  it("accepts a custom href and className for the app bar", () => {
    const html = renderToStaticMarkup(createElement(SiteLogo, { href: "/app", className: "order-1" }));
    expect(html).toContain('href="/app"');
    expect(html).toContain("order-1");
  });

  it("the navbar mark SVG has a viewBox and does not stretch with preserveAspectRatio=none", () => {
    const svg = readFileSync(resolve("public/navbar-mark-squircle-cream.svg"), "utf8");
    expect(svg).toMatch(/viewBox="0 0 \d+ \d+"/);
    expect(svg).not.toContain('preserveAspectRatio="none"');
  });
});
