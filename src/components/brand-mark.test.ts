import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BrandMark } from "./brand-mark";

describe("BrandMark", () => {
  const svg = readFileSync(resolve("src/brand/sofinance-mark.svg"), "utf8");
  const icon = readFileSync(resolve("src/app/icon.svg"), "utf8");

  it("matches the C3 satellite geometry (no eyes, no rounded-square plate)", () => {
    const markup = renderToStaticMarkup(createElement(BrandMark, { className: "h-10 w-10" }));
    expect(markup).toContain('viewBox="0 0 64 64"');
    expect(markup).toContain("rotate(-45 32 32)");
    expect(markup).toContain("currentColor");
    expect(markup).toContain('width="26"');
    expect(markup).toContain('height="26"');
    expect(markup).not.toContain("ellipse");
    expect(markup).not.toContain("circle");
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
    expect(icon).toContain("rotate(-45 32 32)");
    expect(icon).not.toContain("ellipse");
  });
});
