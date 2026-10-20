import { describe, expect, it } from "vitest";
import {
  formatAprPct,
  formatUsd,
  freshnessLabel,
  HOMEPAGE_POOL_LIMIT,
  HOMEPAGE_TVL_FLOOR_USD,
  selectHomepagePools,
  sortPoolsByTvl,
} from "./homepage-pools";

const pool = (id: string, tvlUsd: number | null, apr = 10) => ({
  poolAddress: id,
  tvlUsd,
  estimatedFeeAprPct: apr,
});

describe("sortPoolsByTvl", () => {
  it("ranks the largest TVL first so a tiny high-APR pool does not headline", () => {
    const rows = sortPoolsByTvl([
      pool("sndk", 953, 428.8),
      pool("spcx", 256_900, 12.6),
      pool("amd", 1_200, 135.6),
    ]);
    expect(rows.map((row) => row.poolAddress)).toEqual(["spcx", "amd", "sndk"]);
  });

  it("treats missing TVL as the bottom of the list", () => {
    const rows = sortPoolsByTvl([pool("none", null, 999), pool("mid", 5_000, 1)]);
    expect(rows.map((row) => row.poolAddress)).toEqual(["mid", "none"]);
  });
});

describe("selectHomepagePools", () => {
  it("drops sub-floor TVL pools when larger ones exist, and caps the list", () => {
    const rows = Array.from({ length: 8 }, (_, i) => pool(`big-${i}`, HOMEPAGE_TVL_FLOOR_USD + i * 1_000));
    rows.push(pool("sndk", 953, 428.8));
    const picked = selectHomepagePools(rows);
    expect(picked).toHaveLength(HOMEPAGE_POOL_LIMIT);
    expect(picked[0]?.poolAddress).toBe("big-7");
    expect(picked.some((row) => row.poolAddress === "sndk")).toBe(false);
  });

  it("falls back to TVL order when every pool is below the floor", () => {
    const picked = selectHomepagePools([
      pool("sndk", 953, 428.8),
      pool("amd", 1_200, 135.6),
    ]);
    expect(picked.map((row) => row.poolAddress)).toEqual(["amd", "sndk"]);
  });

  it("swaps in a highlighted pool that would otherwise be clipped", () => {
    const rows = Array.from({ length: 8 }, (_, i) =>
      pool(`big-${i}`, HOMEPAGE_TVL_FLOOR_USD + 50_000 + i),
    );
    rows.push(pool("tweet-pool", HOMEPAGE_TVL_FLOOR_USD + 1, 8));
    const picked = selectHomepagePools(rows, "tweet-pool");
    expect(picked).toHaveLength(HOMEPAGE_POOL_LIMIT);
    expect(picked.at(-1)?.poolAddress).toBe("tweet-pool");
  });
});

describe("homepage number labels", () => {
  it("formats TVL the way pair cards do", () => {
    expect(formatUsd(256_900)).toBe("$256.9k");
    expect(formatUsd(1_250_000)).toBe("$1.25M");
    expect(formatUsd(953)).toBe("$953.00");
    expect(formatUsd(null)).toBe("—");
  });

  it("formats est. APR to two decimals", () => {
    expect(formatAprPct(12.6)).toBe("12.60%");
    expect(formatAprPct(428.8)).toBe("428.80%");
    expect(formatAprPct(null)).toBe("—");
  });

  it("prints snapshot age in minutes", () => {
    const now = Date.parse("2026-10-20T12:00:00.000Z");
    expect(freshnessLabel("2026-10-20T11:47:00.000Z", now)).toBe("Updated 13 min ago");
    expect(freshnessLabel("2026-10-20T11:59:20.000Z", now)).toBe("Updated 1 min ago");
    expect(freshnessLabel("2026-10-20T11:59:50.000Z", now)).toBe("Updated just now");
  });
});
