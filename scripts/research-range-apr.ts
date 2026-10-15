import "@/lib/engine-host";
/**
 * Read-only research harness for docs/rwa-range-apr.md: compares candidate APR methods on live pools.
 *   npx tsx scripts/research-range-apr.ts [poolId ...]
 * Uses the same modules as /api/pool-range-apr; nothing is signed or sent.
 */
import "../src/mcp/server-only-mock.js";
import { assemblePoolRangeApr, loadVolumeProfile } from "../src/lib/pool-range-apr";
import { readOnchainPoolLiquidity } from "../src/lib/range-apr/onchain-liquidity";
import { usdPerLiquidity } from "../src/lib/range-apr/clmm-liquidity";
import { sqrtPriceAtTick } from "@sofinance/engine/range-apr/tick-math";
import { estimateRangeApr } from "../src/lib/range-apr/range-apr";

const DEFAULT_POOLS = [
  "5MBpNcWTqiWy3pZX17pYfgP2ZxrSkok4naQWLj3XLDLY",
  "DUzBLHZ5RZdftPuWVijsvjupndogRM1adGJpsR7YTJro",
  "3ofY6ksvi5m2wRfKmYebCm4EoCWbciWgimaiieeL36hW",
  "ERVsqZ1QAdQhoShqPhB2dFGu2CWQAa1tWzpQbi64ku9K",
  "CxEUkLtuPsmiVgmnaCnEM7Ki6yzLiuP8wE7dVKUTWXdQ",
];

const pct = (value: number | null | undefined) => (value === null || value === undefined ? "n/a" : `${value.toFixed(2)}%`);

async function main() {
  const pools = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_POOLS;
  const now = Math.floor(Date.now() / 1000);
  for (const poolId of pools) {
    const profile = await loadVolumeProfile(poolId, fetch, now);
    const chain = await readOnchainPoolLiquidity(poolId);
    const c = assemblePoolRangeApr(poolId, profile, chain, now);
    const noPath = assemblePoolRangeApr(poolId, { ...profile, candles: null }, chain, now);
    const absolute = assemblePoolRangeApr(poolId, profile, chain, now, { rebase: false });
    const e = profile.economics;
    const grossPool = (c.model.avgDailyVolumeUsd * e.feeRate * 365 / e.tvlUsd) * 100;
    console.log(`\n=== ${poolId} spacing=${c.pool.tickSpacing} fee=${e.feeRate} tvl=$${e.tvlUsd.toFixed(0)} ` +
      `avgVol(${c.sample.days}d,${c.sample.volumeSource})=$${c.model.avgDailyVolumeUsd.toFixed(0)}/d candles=${c.sample.candleCount} confidence=${c.sample.confidence} unplaced=${c.sample.unplacedVolumePct.toFixed(1)}%`);
    console.log(`A pool-level: Raydium day=${pct(e.dayFeeApr)} week=${pct(e.weekFeeApr)} | mine gross=${pct(grossPool)} LP-net=${pct(grossPool * c.pool.lpFeeFraction)}`);
    const here = c.model.bins.find((bin) => bin.tick === Math.floor(c.pool.tickCurrent / c.pool.tickSpacing) * c.pool.tickSpacing)!;
    console.log(`active liquidity at current bin L=${here.liquidity.toExponential(3)}; bins=${c.model.bins.length}`);
    // Validation: value the whole liquidity profile at today's price and compare with Raydium's TVL.
    const implied = c.model.bins.reduce((sum, bin) => sum + bin.liquidity *
      usdPerLiquidity(c.model.currentSqrt, sqrtPriceAtTick(bin.tick), sqrtPriceAtTick(bin.tick + c.pool.tickSpacing), c.model.usdPerRawB), 0);
    console.log(`profile-implied TVL in +-window = $${implied.toFixed(0)} vs Raydium TVL $${e.tvlUsd.toFixed(0)} (${(implied / e.tvlUsd * 100).toFixed(0)}%)`);
    for (const preset of c.presets) {
      const noPathPreset = noPath.presets.find((p) => p.id === preset.id)!;
      const width = (preset.tickUpper - preset.tickLower);
      const sqrtRatio = Math.pow(1.0001, width / 4); // (pb/pa)^(1/4)
      const naive = grossPool * (1 / (1 - 1 / sqrtRatio)) * c.pool.lpFeeFraction; // D: pool APR x "full-range multiplier"
      const cE = preset.estimate, bE = noPathPreset.estimate;
      const aE = absolute.presets.find((p) => p.id === preset.id)!.estimate;
      console.log(
        `  ${preset.id.padEnd(8)} ticks[${preset.tickLower},${preset.tickUpper}] width=${width}t ` +
        `B(active-tick,100%in)=${bE.status === "ok" ? pct(bE.aprPct) : bE.reason}  ` +
        `C0(absolute history)=${aE.status === "ok" ? `${pct(aE.aprPct)} in=${aE.inRangeVolumePct.toFixed(0)}%` : aE.reason}  C(rebased)=${cE.status === "ok" ? `${pct(cE.aprPct)} inRange=${cE.inRangeVolumePct.toFixed(0)}%` : cE.reason}  ` +
        `D(naive multiplier)=${pct(naive)}`);
    }
    // dilution check: capital sensitivity for the Micro band
    const ai = c.presets.find((p) => p.id === "micro")!;
    for (const capital of [10, 100, 1000, 10000]) {
      const r = estimateRangeApr({ tickSpacing: c.pool.tickSpacing, bins: c.model.bins, currentSqrt: c.model.currentSqrt,
        usdPerRawB: c.model.usdPerRawB, feeRate: c.pool.feeRate, lpFeeFraction: c.pool.lpFeeFraction,
        avgDailyVolumeUsd: c.model.avgDailyVolumeUsd, capitalUsd: capital }, ai);
      console.log(`   Micro @ $${capital}: ${r.status === "ok" ? pct(r.aprPct) : r.reason}`);
    }
  }
}
void main();
