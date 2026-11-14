import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("site icons", () => {
  const icon = readFileSync(resolve("src/app/icon.svg"), "utf8");
  const favicon = readFileSync(resolve("public/favicon.svg"), "utf8");

  it("uses the cream H squircle for tab favicons, not the dark canvas mark", () => {
    for (const svg of [icon, favicon]) {
      expect(svg).toContain('viewBox="0 0 32 32"');
      expect(svg).toContain('width="32"');
      expect(svg).toContain('fill="#f4f0e6"');
      expect(svg).toContain('stroke="#84e9c5"');
      expect(svg).toContain('stroke="#f3e76b"');
      expect(svg).toContain('fill="#cdc6ff"');
      expect(svg).toContain("cream-sq");
      // Eyes stay ink, but the tile itself is no longer a dark rect.
      expect(svg).not.toContain('<rect width="32" height="32" fill="#0b0b0b"/>');
      expect(svg).not.toContain('fill="#0a0a0a"');
      expect(svg).not.toContain("A23 23 0 1 1");
    }
    expect(icon).toBe(favicon);
  });
});
