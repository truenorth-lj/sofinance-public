/**
 * Read-only leftover comparison: engine loop vs single-shot allocation.
 *   npx tsx scripts/measure-open-allocate.ts
 *
 * Uses live Jupiter quotes (api.jup.ag) and live pool state (RPC, Raydium API fallback).
 * Nothing is signed or sent.
 */
import "../src/lib/engine-host";
import { PoolInfoLayout } from "@raydium-io/raydium-sdk-v2";
import { TickUtil } from "@raydium-io/raydium-sdk-v2";
import { PublicKey } from "@solana/web3.js";
import { USDC_MINT } from "@sofinance/engine/ids";
import { resolveOpenRange } from "@sofinance/engine/open-range";
import {
  allocateOpenPosition, extraUnpairedPct, leftoverIsMateriallyWorse, type OpenAllocateMode,
  type OpenAllocatePool, type OpenAllocateQuote, type OpenAllocateResult,
} from "../src/lib/open-allocate";

const USDC = USDC_MINT;
const RPC = process.env.SOLANA_RPC_URL?.trim() || "https://api.mainnet-beta.solana.com";
const JUPITER = "https://api.jup.ag/swap/v1/quote";
const RAYDIUM_IDS = "https://api-v3.raydium.io/pools/info/ids";
const SLIPPAGE_BPS = 50;
const PAUSE_MS = 450;

const CASES: { label: string; poolId: string; depositsUsd: number[] }[] = [
  { label: "SNDK/SNDKx", poolId: "9nnephnEJQsBgUbHsDebKpf7vpC9S9Q6T5q1rYQQSoxT", depositsUsd: [100, 1_000] },
  { label: "SPCX/SPCXx", poolId: "DUzBLHZ5RZdftPuWVijsvjupndogRM1adGJpsR7YTJro", depositsUsd: [100, 1_000] },
  { label: "TSLA/TSLAx", poolId: "Dk8jvXxpjdNEHQWXHcW1uKpUFTyhkAuSxqonqAv7d9sD", depositsUsd: [100, 1_000] },
];

const PRESETS = ["standard"] as const;
const MODES: OpenAllocateMode[] = ["loop", "single-shot", "single-shot-adjusted"];

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getJson(url: string, init?: RequestInit, tries = 4): Promise<unknown> {
  let last: unknown;
  for (let attempt = 0; attempt < tries; attempt++) {
    const response = await fetch(url, { ...init, cache: "no-store", signal: AbortSignal.timeout(20_000) });
    if (response.status === 429) {
      await sleep(1_500 * (attempt + 1));
      last = new Error(`429 ${url}`);
      continue;
    }
    const text = await response.text();
    if (!response.ok) {
      last = new Error(`${response.status} ${url}: ${text.slice(0, 200)}`);
      await sleep(600 * (attempt + 1));
      continue;
    }
    return JSON.parse(text) as unknown;
  }
  throw last instanceof Error ? last : new Error(String(last));
}

type LivePool = OpenAllocatePool & {
  label: string;
  poolId: string;
  mintA: string;
  mintB: string;
  decimalsA: number;
  decimalsB: number;
  symbolA: string;
  symbolB: string;
  price: string;
  tvlUsd: number | null;
  source: string;
};

async function readRpcPool(poolId: string): Promise<{
  mintA: string; mintB: string; decimalsA: number; decimalsB: number;
  tickCurrent: number; tickSpacing: number; sqrtPriceX64: string; poolLiquidity: string;
} | null> {
  try {
    const body = await getJson(RPC, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "getAccountInfo",
        params: [poolId, { encoding: "base64", commitment: "confirmed" }],
      }),
    });
    const encoded = (body as { result?: { value?: { data?: [string, string] } } }).result?.value?.data?.[0];
    if (!encoded) return null;
    const state = PoolInfoLayout.decode(Buffer.from(encoded, "base64"));
    return {
      mintA: new PublicKey(state.mintA).toBase58(),
      mintB: new PublicKey(state.mintB).toBase58(),
      decimalsA: Number(state.mintDecimalsA),
      decimalsB: Number(state.mintDecimalsB),
      tickCurrent: Number(state.tickCurrent),
      tickSpacing: Number(state.tickSpacing),
      sqrtPriceX64: state.sqrtPriceX64.toString(),
      poolLiquidity: state.liquidity.toString(),
    };
  } catch {
    return null;
  }
}

async function readRaydiumPool(poolId: string) {
  const body = await getJson(`${RAYDIUM_IDS}?ids=${encodeURIComponent(poolId)}`);
  const row = (body as { data?: unknown[] }).data?.[0] as {
    mintA?: { address?: string; decimals?: number; symbol?: string };
    mintB?: { address?: string; decimals?: number; symbol?: string };
    price?: number;
    tvl?: number;
    feeRate?: number;
    config?: { tickSpacing?: number; tradeFeeRate?: number };
  } | undefined;
  if (!row?.mintA?.address || !row.mintB?.address || !row.price) return null;
  const decimalsA = Number(row.mintA.decimals);
  const decimalsB = Number(row.mintB.decimals);
  const tickSpacing = Number(row.config?.tickSpacing ?? 1);
  const Decimal = (await import("decimal.js")).default;
  const sqrt = TickUtil.priceToSqrtPriceX64(new Decimal(row.price), decimalsA, decimalsB);
  return {
    mintA: row.mintA.address,
    mintB: row.mintB.address,
    decimalsA, decimalsB,
    symbolA: row.mintA.symbol ?? "A",
    symbolB: row.mintB.symbol ?? "B",
    tickSpacing,
    tickCurrent: TickUtil.getTickAtSqrtPrice(sqrt),
    sqrtPriceX64: sqrt.toString(),
    price: String(row.price),
    tvlUsd: typeof row.tvl === "number" ? row.tvl : null,
    feeTierBps: Math.round((row.feeRate ?? 0) * 10_000),
  };
}

async function loadPool(label: string, poolId: string): Promise<LivePool> {
  const [rpc, ray] = await Promise.all([readRpcPool(poolId), readRaydiumPool(poolId)]);
  if (!rpc && !ray) throw new Error(`Could not load pool ${label} ${poolId}`);
  const mintA = rpc?.mintA ?? ray!.mintA;
  const mintB = rpc?.mintB ?? ray!.mintB;
  const decimalsA = rpc?.decimalsA ?? ray!.decimalsA;
  const decimalsB = rpc?.decimalsB ?? ray!.decimalsB;
  const tickCurrent = rpc?.tickCurrent ?? ray!.tickCurrent;
  const tickSpacing = rpc?.tickSpacing ?? ray!.tickSpacing;
  const sqrtPriceX64 = rpc?.sqrtPriceX64 ?? ray!.sqrtPriceX64;
  const price = TickUtil.sqrtPriceX64ToPrice(
    new (await import("bn.js")).default(sqrtPriceX64), decimalsA, decimalsB,
  ).toString();
  return {
    label, poolId, mintA, mintB, decimalsA, decimalsB,
    symbolA: ray?.symbolA ?? "A", symbolB: ray?.symbolB ?? "B",
    sqrtPriceX64, tickCurrent, tickSpacing,
    tickLower: 0, tickUpper: 0, lowerSqrtX64: "0", upperSqrtX64: "0",
    poolLiquidity: rpc?.poolLiquidity ?? "0",
    feeTierBps: ray?.feeTierBps ?? 0,
    price, tvlUsd: ray?.tvlUsd ?? null,
    source: rpc && ray ? "rpc+raydium" : rpc ? "rpc" : "raydium",
  };
}

function withRange(live: LivePool, preset: "standard"): LivePool {
  const resolved = resolveOpenRange({
    range: { preset },
    currentPrice: Number(live.price),
    tickCurrent: live.tickCurrent,
    sqrtPriceX64: live.sqrtPriceX64,
    decimalsA: live.decimalsA,
    decimalsB: live.decimalsB,
    tickSpacing: live.tickSpacing,
  });
  return {
    ...live,
    tickLower: resolved.tickLower,
    tickUpper: resolved.tickUpper,
    lowerSqrtX64: TickUtil.getSqrtPriceAtTick(resolved.tickLower).toString(),
    upperSqrtX64: TickUtil.getSqrtPriceAtTick(resolved.tickUpper).toString(),
  };
}

type JupiterQuote = {
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  routePlan?: { swapInfo?: { ammKey?: string; inputMint?: string; outputMint?: string; inAmount?: string }; bps?: number }[];
};

async function quoteJupiter(
  inputMint: string, outputMint: string, amount: bigint, live: LivePool,
): Promise<OpenAllocateQuote> {
  const url = `${JUPITER}?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${SLIPPAGE_BPS}&instructionVersion=V2`;
  await sleep(PAUSE_MS);
  const body = await getJson(url) as JupiterQuote;
  const minOut = BigInt(body.otherAmountThreshold);
  let ownPoolIn: bigint | undefined;
  let ownPoolZeroForOne: boolean | undefined;
  for (const hop of body.routePlan ?? []) {
    if (hop.swapInfo?.ammKey !== live.poolId) continue;
    const hopIn = hop.swapInfo.inputMint;
    const hopOut = hop.swapInfo.outputMint;
    const zeroForOne = hopIn === live.mintA && hopOut === live.mintB;
    const oneForZero = hopIn === live.mintB && hopOut === live.mintA;
    if (!zeroForOne && !oneForZero) continue;
    ownPoolIn = BigInt(hop.swapInfo.inAmount ?? "0");
    ownPoolZeroForOne = zeroForOne;
  }
  return { spend: amount, minOut, ownPoolIn, ownPoolZeroForOne };
}

function quoteFn(live: LivePool): (side: "A" | "B", spend: bigint) => Promise<OpenAllocateQuote> {
  return async (side, spend) => quoteJupiter(USDC, side === "A" ? live.mintA : live.mintB, spend, live);
}

type Row = {
  pair: string;
  depositUsd: number;
  preset: string;
  mode: OpenAllocateMode;
  rounds: number;
  quotes: number;
  wallMs: number;
  unpairedPct: number;
  mismatchPct: number;
  extraVsLoopPct: number | null;
  converged: boolean;
  spendA: string;
  spendB: string;
};

function fmt(n: number, digits = 3) {
  return n.toFixed(digits);
}

async function measureCase(live: LivePool, depositUsd: number, preset: "standard"): Promise<Row[]> {
  const pooled = withRange(live, preset);
  const requested = BigInt(depositUsd) * 1_000_000n;
  const quote = quoteFn(pooled);
  const cache = new Map<string, Promise<OpenAllocateQuote>>();
  const quoteMs = new Map<string, number>();
  const cached: typeof quote = (side, spend) => {
    const key = `${side}:${spend}`;
    const hit = cache.get(key);
    if (hit) return hit;
    const t0 = Date.now();
    const pending = quote(side, spend).finally(() => quoteMs.set(key, Date.now() - t0));
    cache.set(key, pending);
    return pending;
  };

  const results: { result: OpenAllocateResult; keys: string[] }[] = [];
  for (const mode of MODES) {
    const used: string[] = [];
    const tracking: typeof quote = (side, spend) => {
      used.push(`${side}:${spend}`);
      return cached(side, spend);
    };
    try {
      const result = await allocateOpenPosition({
        pool: pooled, requested, mode, quote: tracking, strict: false,
      });
      results.push({ result, keys: used });
    } catch (error) {
      process.stderr.write(`    ${mode} failed: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }
  const loop = results.find((item) => item.result.mode === "loop")?.result;
  const wallFor = (keys: string[]) =>
    [...new Set(keys)].reduce((sum, key) => sum + (quoteMs.get(key) ?? 0), 0);
  return results.map(({ result: item, keys }) => ({
    pair: live.label,
    depositUsd,
    preset,
    mode: item.mode,
    rounds: item.rounds,
    quotes: item.quotes,
    wallMs: wallFor(keys),
    unpairedPct: item.unpairedPct,
    mismatchPct: item.mismatchPct,
    extraVsLoopPct: item.mode === "loop" || !loop ? 0 : extraUnpairedPct(item, loop),
    converged: item.converged,
    spendA: item.spendA.toString(),
    spendB: item.spendB.toString(),
  }));
}

function table(rows: Row[]) {
  const head = [
    "pair", "deposit", "mode", "rounds", "quotes", "wall_ms",
    "unpaired_%", "mismatch_%", "extra_vs_loop_%", "converged",
  ];
  const lines = [
    `| ${head.join(" | ")} |`,
    `| ${head.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${[
      row.pair,
      `$${row.depositUsd}`,
      row.mode,
      String(row.rounds),
      String(row.quotes),
      String(row.wallMs),
      fmt(row.unpairedPct),
      fmt(row.mismatchPct),
      row.extraVsLoopPct === null ? "—" : fmt(row.extraVsLoopPct),
      row.converged ? "yes" : "no",
    ].join(" | ")} |`),
  ];
  return lines.join("\n");
}

async function main() {
  const rows: Row[] = [];
  for (const spec of CASES) {
    process.stderr.write(`loading ${spec.label}…\n`);
    const live = await loadPool(spec.label, spec.poolId);
    process.stderr.write(
      `  ${live.symbolA}/${live.symbolB} price=${live.price} spacing=${live.tickSpacing} ` +
      `tvl=${live.tvlUsd != null ? `$${live.tvlUsd.toFixed(0)}` : "?"} src=${live.source} L=${live.poolLiquidity}\n`,
    );
    for (const deposit of spec.depositsUsd) {
      for (const preset of PRESETS) {
        process.stderr.write(`  measuring ${spec.label} $${deposit} ${preset}…\n`);
        rows.push(...await measureCase(live, deposit, preset));
      }
    }
  }
  const comparisons = rows.filter((row) => row.mode !== "loop");
  const worst = comparisons.reduce((max, row) => Math.max(max, row.extraVsLoopPct ?? 0), 0);
  const recommendLoop = comparisons.some((row) => {
    const loop = rows.find((item) =>
      item.pair === row.pair && item.depositUsd === row.depositUsd && item.mode === "loop");
    return loop && leftoverIsMateriallyWorse(
      { unpairedPct: row.unpairedPct } as OpenAllocateResult,
      { unpairedPct: loop.unpairedPct } as OpenAllocateResult,
    );
  });
  const markdown = table(rows);
  const payload = {
    fetchedAt: new Date().toISOString(),
    materialLeftoverPct: 0.5,
    worstExtraVsLoopPct: worst,
    recommend: recommendLoop ? "loop" : "single-shot-ok-keep-loop-default",
    rows,
    markdown,
  };
  console.log(markdown);
  console.log(`\nworst extra unpaired vs loop: ${worst.toFixed(3)}% of deposit`);
  console.log(`recommend: ${payload.recommend}`);
  const { writeFile } = await import("node:fs/promises");
  await writeFile("/tmp/open-allocate-measure.json", JSON.stringify(payload, null, 2));
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
