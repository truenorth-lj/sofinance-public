import { describe, expect, it } from "vitest";
import fixture from "./fixtures/stock-entry-price-nvda.json";
import { stockReferencePool, type StockReferencePool } from "./stock-reference-pools";
import { entryPriceFromTrades, median, tradeFromTransaction, type PoolTrade, type RawPoolTransaction } from "./stock-entry-price-trades";

const NVDA = "NVDAVuiB7hwd3m5Wa1JuHNovPaPG6BH1QNztbKFxNjv";
const NVDAX = "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const deposit = fixture.deposit;
/** The NVDAx/USDC pool of the original example: not in the static map (xStocks are never a report's base side). */
const NVDAX_REF: StockReferencePool = { mint: NVDAX, symbol: "NVDAx", protocol: "raydium-clmm", pool: "49iMatQtoyabsYAQc8GafVq6aeBFVDxSRH44oiatyyw6",
  stockVault: "DyKsypuzQvhi37K8UvjCMBC43h4HtW4r6jhWoqHyrSSe", usdcVault: "4JEtq7NraU9U5URcCKSv6sWRRgDSuSnUjYDqpSJSWohY" };

function poolTrades(symbol: "NVDA" | "NVDAx") {
  const pool = fixture.pools[symbol];
  const ref = symbol === "NVDA" ? stockReferencePool(NVDA)! : NVDAX_REF;
  const transactions = pool.transactions as unknown as Record<string, RawPoolTransaction>;
  return { ref, pool, trades: pool.signatures.flatMap((item) => {
    const trade = tradeFromTransaction(item.signature, transactions[item.signature] ?? null, ref);
    return trade ? [trade] : [];
  }) };
}

describe("deposit-time entry price from the NVDA example (position opened 2026-11-09 18:49:33 UTC)", () => {
  it("lists the base-side NVDA pool the fixture was read from, and no xStock", () => {
    expect(stockReferencePool(NVDA)?.pool).toBe(fixture.pools.NVDA.pool);
    expect(stockReferencePool(NVDAX)).toBeNull();
    expect(fixture.pools.NVDAx.pool).toBe(NVDAX_REF.pool);
  });

  it("reads v0 and v1 swaps in the NVDAx/USDC pool and finds the trades 17 s and 40 s before the deposit", () => {
    const { trades } = poolTrades("NVDAx");
    // 12 transactions: two fills under $1 are dust; the other 10 are swaps (2 are v0, 8 are v1).
    expect(trades).toHaveLength(10);
    const at = (seconds: number) => trades.find((trade) => deposit.blockTime - trade.blockTime === seconds)!;
    expect(at(17).priceUsd).toBeCloseTo(177.43, 2);
    expect(at(40).priceUsd).toBeCloseTo(177.46, 2);
    const result = entryPriceFromTrades(trades, deposit.blockTime);
    expect(result.status).toBe("ok");
    // Nearest three usable trades (6 s, 17 s, 24 s before the deposit), median.
    expect(result.trades.map((trade) => deposit.blockTime - trade.blockTime)).toEqual([6, 17, 24]);
    expect(result.priceUsd).toBeCloseTo(177.4288, 4);
  });

  it("reads the NVDA (base-side) pool: a one-sided liquidity add is not a trade", () => {
    const { trades } = poolTrades("NVDA");
    expect(trades.map((trade) => deposit.blockTime - trade.blockTime)).toEqual([2, 3, 4]);
    const add = fixture.pools.NVDA.signatures[0]!.signature;
    expect(trades.some((trade) => trade.signature === add)).toBe(false);
    const result = entryPriceFromTrades(trades, deposit.blockTime);
    expect(result.priceUsd).toBeCloseTo(176.998, 3);
    // CoinGecko's daily close that day was $180.22: 1.8% away from the deposit-time trades.
    expect(Math.abs(180.22 / result.priceUsd! - 1)).toBeGreaterThan(0.015);
  });
});

const ref: StockReferencePool = { mint: NVDA, symbol: "NVDA", protocol: "orca-whirlpool", pool: "pool".padEnd(32, "1"),
  stockVault: "stockVault".padEnd(32, "1"), usdcVault: "usdcVault".padEnd(32, "1") };
const balance = (accountIndex: number, mint: string, amount: string, decimals: number) =>
  ({ accountIndex, mint, uiTokenAmount: { amount, decimals } });
function swap(input: { stock: [string, string]; usdc: [string, string]; err?: unknown; keys?: string[] }): RawPoolTransaction {
  const keys = input.keys ?? ["payer".padEnd(32, "1"), ref.stockVault, ref.usdcVault, "rewardVault".padEnd(32, "1")];
  const stockIndex = keys.indexOf(ref.stockVault), usdcIndex = keys.indexOf(ref.usdcVault);
  return { blockTime: 1_000, transaction: { message: { accountKeys: keys.map((pubkey) => ({ pubkey })) } }, meta: { err: input.err ?? null,
    preTokenBalances: [balance(stockIndex, NVDA, input.stock[0], 6), balance(usdcIndex, USDC, input.usdc[0], 6), balance(3, USDC, "5000000", 6)],
    postTokenBalances: [balance(stockIndex, NVDA, input.stock[1], 6), balance(usdcIndex, USDC, input.usdc[1], 6), balance(3, USDC, "0", 6)] } };
}

describe("tradeFromTransaction", () => {
  it("prices a buy and a sell from the two vaults only", () => {
    expect(tradeFromTransaction("buy", swap({ stock: ["10000000", "9000000"], usdc: ["0", "177000000"] }), ref)?.priceUsd).toBeCloseTo(177, 6);
    expect(tradeFromTransaction("sell", swap({ stock: ["9000000", "11000000"], usdc: ["400000000", "46000000"] }), ref)?.priceUsd).toBeCloseTo(177, 6);
  });

  it("ignores liquidity moves, failed transactions and dust", () => {
    expect(tradeFromTransaction("add", swap({ stock: ["1", "2000001"], usdc: ["0", "354000000"] }), ref)).toBeNull();
    expect(tradeFromTransaction("failed", swap({ stock: ["10000000", "9000000"], usdc: ["0", "177000000"], err: { InstructionError: [0, "Custom"] } }), ref)).toBeNull();
    expect(tradeFromTransaction("dust", swap({ stock: ["10000000", "9995000"], usdc: ["0", "885000"] }), ref)).toBeNull();
    expect(tradeFromTransaction("missing", null, ref)).toBeNull();
  });

  it("maps plain json account keys through the loaded lookup-table addresses", () => {
    const tx = swap({ stock: ["10000000", "9000000"], usdc: ["0", "177000000"], keys: ["payer".padEnd(32, "1"), ref.stockVault, "other".padEnd(32, "1"), "rewardVault".padEnd(32, "1"), ref.usdcVault] });
    const plain: RawPoolTransaction = { ...tx, transaction: { message: { accountKeys: ["payer".padEnd(32, "1"), ref.stockVault, "other".padEnd(32, "1"), "rewardVault".padEnd(32, "1")] } },
      meta: { ...tx.meta!, loadedAddresses: { writable: [ref.usdcVault], readonly: [] } } };
    expect(tradeFromTransaction("plain", plain, ref)?.priceUsd).toBeCloseTo(177, 6);
  });
});

describe("entryPriceFromTrades", () => {
  const trade = (secondsBefore: number, priceUsd: number): PoolTrade => ({ signature: `t${secondsBefore}`, blockTime: 10_000 - secondsBefore, priceUsd, usdcSize: 50 });
  it("takes the median of the three nearest trades within the hour before the deposit", () => {
    expect(entryPriceFromTrades([trade(5, 100), trade(50, 102), trade(20, 101), trade(70, 500)], 10_000).priceUsd).toBe(101);
    expect(entryPriceFromTrades([trade(5, 100), trade(20, 102)], 10_000).priceUsd).toBe(101);
  });
  it("has no price when the nearest trade is more than an hour old", () => {
    expect(entryPriceFromTrades([trade(3_601, 100)], 10_000)).toEqual({ status: "no_trade", priceUsd: null, trades: [] });
    expect(entryPriceFromTrades([], 10_000).status).toBe("no_trade");
  });
  it("median", () => { expect(median([3, 1, 2])).toBe(2); expect(median([4, 1, 3, 2])).toBe(2.5); });
});
