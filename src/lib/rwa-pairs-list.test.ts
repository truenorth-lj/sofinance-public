import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { RWA_PAIRS_LIST_PATH } from "./rwa-pairs-list";

describe("shared RWA pairs list fetch", () => {
  it("points homepage, pair cards, and the plan picker at the same cached query", () => {
    expect(RWA_PAIRS_LIST_PATH).toBe("/api/rwa-pairs?minTvl=0&maxPages=10&sortBy=estimatedFeeApr");
    for (const file of [
      "src/components/homepage-pools-table.tsx",
      "src/components/rwa-pairs-panel.tsx",
      "src/components/plan/use-rwa-pairs.ts",
    ]) {
      expect(readFileSync(resolve(file), "utf8"), file).toContain("fetchRwaPairsList");
    }
  });
});
