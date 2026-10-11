import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BrandMark } from "./brand-mark";

describe("BrandMark", () => {
  const svg = readFileSync(resolve("src/brand/sofinance-mark.svg"), "utf8");
  const icon = readFileSync(resolve("src/app/icon.svg"), "utf8");

  it("matches the orbit geometry (core, open ring, satellite dot; no hard-coded colours)", () => {
    const markup = renderToStaticMarkup(createElement(BrandMark, { className: "h-10 w-10" }));
    expect(markup).toContain('viewBox="0 0 64 64"');
    expect(markup).toContain("currentColor");
    expect(markup).toContain('<circle cx="32" cy="32" r="8"');
    expect(markup).toContain("A23 23 0 1 1");
    expect(markup).toContain('<circle cx="48.26" cy="15.74" r="6"');
    expect(markup).not.toContain("<rect");
    expect(markup).not.toContain("ellipse");
    expect(markup).not.toContain("#000");
    expect(markup).not.toContain("#ff6b35");
  });

  it("keeps the source SVG as white shapes on a transparent canvas", () => {
    expect(svg).toContain('viewBox="0 0 64 64"');
    expect(svg).toContain('fill="#fff"');
    expect(svg).not.toContain("rounded");
    expect(svg).not.toMatch(/<rect[^>]*width="64"[^>]*fill=/);
  });

  it("renders favicon/app icons as the white mark on the dark canvas", () => {
    expect(icon).toContain('fill="#0a0a0a"');
    expect(icon).toContain('fill="#fff"');
    expect(icon).toContain("A23 23 0 1 1");
    expect(icon).not.toContain("ellipse");
  });
});
