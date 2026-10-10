import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const quotedFiles = [
  "src/components/selected-app.tsx",
  "src/components/compound-panel.tsx",
];

describe("JSX quote entities", () => {
  it("does not leave literal HTML quote entities in user-facing copy", () => {
    for (const file of quotedFiles) {
      const src = readFileSync(resolve(file), "utf8");
      expect(src, file).not.toContain("&quot;");
      expect(src, file).not.toContain("&amp;");
      expect(src, file).not.toContain("&#39;");
    }
  });

  it("uses the shared wallet prompt without setup or extension warnings", () => {
    const src = readFileSync(resolve("src/components/selected-app.tsx"), "utf8");
    expect(src).toContain("ConnectWalletPrompt");
    expect(src).not.toContain("Reown Project ID");
    expect(src).not.toContain("Wallet extensions not detected");
  });

  it("uses real quotes in the compound confirmation copy", () => {
    const src = readFileSync(resolve("src/components/compound-panel.tsx"), "utf8");
    expect(src).toContain('clicking "One-click compound"');
  });
});
