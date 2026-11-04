import { PublicKey, type Connection } from "@solana/web3.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ unstable_cache: <T,>(fn: T) => fn }));

const quoteSpotSwap = vi.fn();
vi.mock("@sofinance/engine/spot-swap", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sofinance/engine/spot-swap")>();
  return { ...actual, quoteSpotSwap: (...args: unknown[]) => quoteSpotSwap(...args) };
});

import { SpotSwapError } from "@sofinance/engine/spot-swap";
import { JupiterNoRouteError } from "@sofinance/engine/swap/jupiter";
import { SpotSwapNoRouteError, checkSpotSwapWallet, quoteSpotSwapForStock } from "./spot-swap";
import type { SpotSwapStockContext } from "@/lib/stock-market/source";

const TSLAX = "XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB";
const TSLA_BP = "TSLAqBbv4CNCnzWFeB7LmydAyEiNMJtve7DYKLpdK4S";
const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const WALLET = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const context: SpotSwapStockContext = { underlying: "TSLA", candidates: [
  { mint: TSLAX, symbol: "TSLAx", underlying: "TSLA", xstocks: true, jupiter: { name: "Tesla xStock", tags: ["verified", "xstocks"] }, decimals: 8, program: TOKEN },
  { mint: TSLA_BP, symbol: "TSLA", underlying: "TSLA", xstocks: false, jupiter: { name: "Tesla - Backpack Securities", tags: ["verified", "backpack"] }, decimals: 9, program: TOKEN },
] };
const quote = (mint: string) => ({ outputMint: mint, outputMintShort: "x", outputSymbol: "TSLAx", issuerName: "xStocks", xstocks: true, amount: "2000000",
  feeBps: 10, feeAmount: "2000", feeWalletShort: "CS5C…AK", quotedOut: "450000", minOut: "447750", priceImpactPct: "0.001",
  newAccountRentLamports: 2_039_280, baseNetworkFeeLamports: 5000 });
const impact = new SpotSwapError("spot_swap_price_impact", "There isn't enough trading liquidity to buy this amount without moving the price more than 1%. Try a smaller amount.");

beforeEach(() => { quoteSpotSwap.mockReset(); });

describe("quoteSpotSwapForStock", () => {
  it("quotes the engine's issuer for this amount with its decimals and the 0.5% slippage limit", async () => {
    quoteSpotSwap.mockResolvedValue(quote(TSLAX));
    const result = await quoteSpotSwapForStock(context, "2", null);
    expect(result.quote).toMatchObject({ outputMint: TSLAX, outputDecimals: 8, slippageBps: 50, feeAmount: "2000" });
    expect(result.wallet).toBeNull();
    expect(quoteSpotSwap).toHaveBeenCalledTimes(1);
  });

  it("over 1% price impact on xStocks tries the next issuer", async () => {
    quoteSpotSwap.mockImplementation(async (mint: string) => { if (mint === TSLAX) throw impact; return quote(mint); });
    const result = await quoteSpotSwapForStock(context, "2", null);
    expect(result.quote).toMatchObject({ outputMint: TSLA_BP, outputDecimals: 9 });
  });

  it("refuses with the engine's price-impact message when every issuer is over 1%", async () => {
    quoteSpotSwap.mockImplementation(async () => { throw impact; });
    await expect(quoteSpotSwapForStock(context, "5000", null)).rejects.toBe(impact);
  });

  it("no route on every issuer -> a plain no-route error", async () => {
    quoteSpotSwap.mockImplementation(async () => { throw new JupiterNoRouteError(); });
    await expect(quoteSpotSwapForStock(context, "2", null)).rejects.toBeInstanceOf(SpotSwapNoRouteError);
  });
});

describe("checkSpotSwapWallet", () => {
  const candidate = { mint: TSLAX, program: TOKEN };
  const connection = (lamports: number, outputExists: boolean) => ({
    getMultipleAccountsInfo: vi.fn(async () => [{ lamports, owner: PublicKey.default, data: Buffer.alloc(0), executable: false },
      outputExists ? { lamports: 1, owner: new PublicKey(TOKEN), data: Buffer.alloc(165), executable: false } : null, null]),
  }) as unknown as Connection;

  it("needs the deposit + base fee when the token account is new, and flags SOL too low", async () => {
    const low = await checkSpotSwapWallet(WALLET, candidate, { amount: "2000000", newAccountRentLamports: "2039280" }, connection(1_000_000, false));
    expect(low).toMatchObject({ outputAccountExists: false, requiredLamports: "2044280", solSufficient: false, usdcBalance: "0", usdcSufficient: false });
    const ok = await checkSpotSwapWallet(WALLET, candidate, { amount: "2000000", newAccountRentLamports: "2039280" }, connection(3_000_000, false));
    expect(ok.solSufficient).toBe(true);
  });

  it("needs only the base fee when the token account already exists", async () => {
    const result = await checkSpotSwapWallet(WALLET, candidate, { amount: "2000000", newAccountRentLamports: "2039280" }, connection(10_000, true));
    expect(result).toMatchObject({ outputAccountExists: true, requiredLamports: "5000", solSufficient: true });
  });
});
