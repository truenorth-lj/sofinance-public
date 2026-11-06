import { readFileSync } from "node:fs";
import type { BrowserContext } from "@playwright/test";
import { randomAddress } from "./tx";

/**
 * Hermetic data for the mobile-layout check: a pool list, one Raydium position and one Meteora DLMM position with long
 * amounts (the shape that squeezed the My positions rows on a 390 px phone), and a few wallet assets. Nothing is signed.
 */
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
// Public read-only API answers captured from the live site on 2026-11-04 (token icon URLs removed: no third-party hosts).
// stock-market.json: the homepage cards from a Jupiter search read the same day; its Buy options are illustrative.
const PAIRS = fixture("rwa-pairs.json");
const RHC_POOLS = fixture("protocol-pools-rhc.json");
const SOL_PRICE = fixture("sol-usdc-price.json");
const STOCKS = fixture("stock-market.json");
const RANGE_APR = JSON.parse(fixture("pool-range-apr.json")) as Record<string, unknown>;
const SPCX = "SPCXxcqXj6e5dJDVNovHN8744zkbhM2bYudU45BimGb";
const SPCXX = "Xs3oZwbHvqis4NYcf4YKWmEia2eC84wSiVrcYcTqpH8";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SOL = "So11111111111111111111111111111111111111112";
const METEORA_POOL = "5pw5tNUaZJpUCnYjZ1V3gd7XkLbrb4zA9pir4LFph2mj";
const RAYDIUM_POOL = "DUzBLHZ5RZdftPuWVijsvjupndogRM1adGJpsR7YTJro";

export async function installLayoutMocks(context: BrowserContext, owner: string, unmocked: Set<string> = new Set()) {
  const positionMint = randomAddress(), positionAccount = randomAddress(), meteoraPosition = randomAddress();
  const selection = { positionMint, inputMint: USDC, inputKind: "token" };
  const state = { wallet: owner, ...selection, poolId: RAYDIUM_POOL, positionAccount,
    slot: 42, solLamports: 1_000_000_000, inputDecimals: 6, inputBalance: "1234567890", inputAccount: randomAddress(), nftAta: randomAddress(),
    mintA: SPCX, mintB: SPCXX, decimalsA: 6, decimalsB: 8, ownsNft: true, sufficientSol: true, unsupportedExtensions: [],
    paused: false, frozen: false, transferFee: false, rangeSide: "inside", inRange: true,
    price: "1.0004", tickLower: -10, tickUpper: 10, liquidity: "123456789", currentAmounts: { a: "38884786", b: "3888478600" },
    balances: { input: "1234567890", a: "0", b: "0" }, fees: { a: "901", b: "90100" }, rewards: [], eligible: true };
  const meteora = { key: `meteora-dlmm:${meteoraPosition}`, source: "meteora-dlmm", chain: "solana", nativeId: meteoraPosition, poolId: METEORA_POOL,
    tokenA: { id: SPCX, symbol: "SPCX", decimals: 6 }, tokenB: { id: SPCXX, symbol: "SPCXx", decimals: 8 },
    range: { mode: "price", lower: 0.98123, upper: 1.02456, current: 1.0004 }, rangeStatus: "in", liquidity: "38884786", valueUsd: null,
    holdings: { liquidityRaw: { a: "38884786", b: "3888478600" }, unclaimedFeesRaw: { a: "901", b: "90100" } }, native: { position: meteoraPosition } };
  const json = (value: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(value) });
  await context.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path === "/api/rwa-pairs") return route.fulfill({ status: 200, contentType: "application/json", body: PAIRS });
    if (path === "/api/wallet") return route.fulfill(json({ wallet: owner, slot: 1, fetchedAt: Date.now(),
      positions: [{ ...state, symbolA: "SPCX", symbolB: "SPCXx", feeTierBps: 1, tickCurrent: 0 }],
      assets: [
        { kind: "token", mint: USDC, eligible: true, decimals: 6, balance: "1234567890", totalBalance: "1234567890", reason: null },
        { kind: "native", mint: SOL, eligible: true, decimals: 9, balance: "1500000000", totalBalance: "1500000000", reason: null },
        { kind: "token", mint: SPCX, eligible: true, decimals: 6, balance: "38884786", totalBalance: "38884786", reason: null },
        { kind: "token", mint: randomAddress(), eligible: false, decimals: 6, balance: "1", totalBalance: "1", reason: "Not available for deposit: unknown token with a very long explanation that must wrap" },
      ] }));
    if (path === "/api/dex/meteora-dlmm/positions") return route.fulfill(json({ positions: [meteora] }));
    if (/^\/api\/dex\/[^/]+\/positions$/.test(path)) return route.fulfill(json({ positions: [] }));
    if (path === "/api/selected-state" || path === "/api/compound-state") return route.fulfill(json(state));
    if (path === "/api/token-metadata") return route.fulfill(json({}));
    if (path === "/api/transaction-finality") return route.fulfill(json({ status: "pending" }));
    if (path === "/api/stock-market") return route.fulfill({ status: 200, contentType: "application/json", body: STOCKS });
    if (path === "/api/sol-usdc-price") return route.fulfill({ status: 200, contentType: "application/json", body: SOL_PRICE });
    if (path === "/api/protocol-pools" && url.searchParams.get("protocol") === "uniswap-v4-rhc") return route.fulfill({ status: 200, contentType: "application/json", body: RHC_POOLS });
    // One captured Raydium range answer stands in for every Solana pool (the layout, not the numbers, is under test).
    if (path === "/api/pool-range-apr") return route.fulfill(json({ ...RANGE_APR, poolId: url.searchParams.get("poolId") }));
    // Anything else (performance, daily APR, quotes, Robinhood Chain reads) answers like an unavailable upstream: the
    // panels then show their plain error copy, which has to fit a phone too. Never the real server or RPC.
    unmocked.add(`${route.request().method()} ${path}`);
    return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "This data is not available right now." }) });
  });
}
