import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("site icons", () => {
  const icon = readFileSync(resolve("src/app/icon.svg"), "utf8");
  const favicon = readFileSync(resolve("public/favicon.svg"), "utf8");

  it("uses the dark simplified H mark for tab favicons", () => {
    for (const svg of [icon, favicon]) {
      expect(svg).toContain('fill="#0b0b0b"');
      expect(svg).toContain('fill="#f4f0e6"');
      expect(svg).toContain('stroke="#84e9c5"');
      expect(svg).toContain('stroke="#f3e76b"');
      expect(svg).toContain('fill="#cdc6ff"');
      expect(svg).not.toContain('fill="#0a0a0a"');
      expect(svg).not.toContain("A23 23 0 1 1");
    }
    expect(icon).toContain('width="64"');
    expect(favicon).toContain('width="32"');
  });
});
