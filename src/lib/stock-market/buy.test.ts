import { PublicKey, type AccountInfo } from "@solana/web3.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const issues = new Map<string, string[]>();
vi.mock("@sofinance/engine/spot-swap", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sofinance/engine/spot-swap")>();
  return {
    ...actual,
    spotSwapMintIssues: (mint: PublicKey, info: AccountInfo<Buffer> | null) => {
      if (!info) throw new actual.SpotSwapError("spot_swap_token_unavailable", "missing");
      return { program: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"), decimals: 8, issues: issues.get(mint.toBase58()) ?? [] };
    },
  };
});

import { computeStockBuyEligibility, spotSwapAllowlistFor } from "./buy";
import type { StockToken } from "./build";

const TSLAX = "XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB";
const TSLA_BP = "TSLAqBbv4CNCnzWFeB7LmydAyEiNMJtve7DYKLpdK4S";
const MSTR_ON = "Bq6KJjdjdjZ1Wh3bJjxRQd6M9WcHL3BqW2zpq7Hondo";

function token(mint: string, underlying: string, issuer: StockToken["issuer"], overrides: Partial<StockToken> = {}): StockToken {
  return { mint, symbol: `${underlying}${issuer === "xstocks" ? "x" : issuer === "ondo" ? "on" : ""}`, underlying, issuer, company: underlying === "TSLA" ? "Tesla" : "Strategy",
    jupiterName: issuer === "backpack" ? "Tesla - Backpack Securities" : `${underlying} token`, jupiterTags: ["verified", "stocks", issuer],
    xstocks: issuer === "xstocks", icon: null, priceUsd: 1, change24hPct: 0, mcapUsd: 2e6, liquidityUsd: 1e5, volume24hUsd: 2e4, ...overrides };
}

const account = { lamports: 1, owner: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"), executable: false, rentEpoch: 0, data: Buffer.alloc(82) } as AccountInfo<Buffer>;
const readMints = vi.fn(async (mints: string[]) => mints.map(() => account));

beforeEach(() => { issues.clear(); readMints.mockClear(); });

describe("computeStockBuyEligibility", () => {
  const market = { tokensByUnderlying: {
    TSLA: [token(TSLAX, "TSLA", "xstocks"), token(TSLA_BP, "TSLA", "backpack")],
    MSTR: [token(MSTR_ON, "MSTR", "ondo")],
  } };

  it("gives a Buy to the engine's selection (xStocks first) and keeps the allowlist with Jupiter metadata", async () => {
    const result = await computeStockBuyEligibility(market, ["TSLA"], { readMints, checkRoute: async () => "ok", isUnavailable: () => false });
    expect(result.options.TSLA).toMatchObject({ mint: TSLAX, issuerName: "xStocks", company: "Tesla", symbol: "TSLAx" });
    expect(result.options.TSLA!.mintShort).toBe("XsDo…oB");
    expect(spotSwapAllowlistFor(result.candidates.TSLA!)[1]).toEqual({ mint: TSLA_BP, symbol: "TSLA", underlying: "TSLA", xstocks: false,
      jupiter: { name: "Tesla - Backpack Securities", tags: ["verified", "stocks", "backpack"] } });
    expect(result.candidates.TSLA![0]).toMatchObject({ decimals: 8, program: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" });
  });

  it("falls back to the next issuer when xStocks has no route", async () => {
    const result = await computeStockBuyEligibility(market, ["TSLA"], { readMints,
      checkRoute: async (mint) => (mint === TSLAX ? "no_route" : "ok"), isUnavailable: () => false });
    expect(result.options.TSLA).toMatchObject({ mint: TSLA_BP, issuerName: "Tesla - Backpack Securities" });
  });

  it("no route for any issuer -> no Buy", async () => {
    const result = await computeStockBuyEligibility(market, ["TSLA"], { readMints, checkRoute: async () => "no_route", isUnavailable: () => false });
    expect(result.options.TSLA).toBeUndefined();
  });

  it("drops a token whose mint has an issue (e.g. multiplier not 1): it is never bought", async () => {
    issues.set(TSLAX, ["scaled UI amount multiplier is not 1"]);
    const checkRoute = vi.fn(async () => "ok" as const);
    const result = await computeStockBuyEligibility(market, ["TSLA"], { readMints, checkRoute, isUnavailable: () => false });
    expect(result.candidates.TSLA!.map((item) => item.mint)).toEqual([TSLA_BP]);
    expect(result.options.TSLA!.mint).toBe(TSLA_BP);
    expect(checkRoute).not.toHaveBeenCalledWith(TSLAX, expect.anything());
  });

  it("an unverified or nameless non-xStocks issuer gets no Buy", async () => {
    const unverified = { tokensByUnderlying: { MSTR: [token(MSTR_ON, "MSTR", "ondo", { jupiterTags: ["stocks"] })] } };
    const nameless = { tokensByUnderlying: { MSTR: [token(MSTR_ON, "MSTR", "ondo", { jupiterName: null })] } };
    for (const item of [unverified, nameless]) {
      const result = await computeStockBuyEligibility(item, ["MSTR"], { readMints, checkRoute: async () => "ok", isUnavailable: () => false });
      expect(result.options.MSTR).toBeUndefined();
    }
  });

  it("a missing mint account never gets a Buy", async () => {
    const result = await computeStockBuyEligibility(market, ["MSTR"], { readMints: async (mints) => mints.map(() => null), checkRoute: async () => "ok", isUnavailable: () => false });
    expect(result.options.MSTR).toBeUndefined();
  });

  it("rethrows an outage so it is not cached as 'not buyable'; any other route error removes only that Buy", async () => {
    const outage = new Error("down");
    await expect(computeStockBuyEligibility(market, ["TSLA"], { readMints, checkRoute: async () => { throw outage; }, isUnavailable: (error) => error === outage }))
      .rejects.toBe(outage);
    const result = await computeStockBuyEligibility(market, ["MSTR", "TSLA"], { readMints,
      checkRoute: async (mint) => { if (mint === MSTR_ON) throw new Error("bad"); return "ok"; }, isUnavailable: () => false });
    expect(Object.keys(result.options)).toEqual(["TSLA"]);
  });
});
