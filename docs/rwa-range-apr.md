# Range APR estimate and the AI-pick preset

Design note for the **Est. fee APR** shown in the Create position modal (`/app/rwa-pairs`) and the
**AI-pick est. APR** line on each pair row. Code: `src/lib/range-apr/`, `src/lib/pool-range-apr.ts`,
`src/app/api/pool-range-apr/route.ts`, UI in `src/components/range-apr/`.

## AI pick (preset)

A **fixed rule, not a model**. In this rule one "tick" is one **tick-spacing unit of the pool** (the distance between
two adjacent valid position boundaries), not a raw 0.01% tick:

* `center` = the valid boundary (multiple of `tickSpacing`) nearest to the pool's *exact* current tick
  (`2·ln(sqrtPrice)/ln(1.0001)`, so it is not just `tickCurrent`); ties go to the lower boundary.
* `tickLower = center − 2·tickSpacing`, `tickUpper = center + 2·tickSpacing` (4 spacing units wide), clamped into the
  usable tick range.
* The current price is always within half a spacing unit of the centre, so it is strictly inside the band.

Examples: spacing 1 → ±2 raw ticks (≈ ±0.02%); spacing 10 → ±0.2%; spacing 60 → ±1.2% (on a 60-spaced pool this is the same
band as Wide). Implemented once in `range-apr/ai-pick.ts`, used by `resolveOpenRange` (so quote/prepare sign exactly the priced
ticks). It is web-only: the MCP `rangePreset` enum and `recommendedRanges` are unchanged. Standard stays the default preset.

## APR method (chosen: "liquidity profile × volume occupancy")

```
for every price bin b (one tick-spacing wide) inside the range:
  fees_b/day = volume_b/day × feeRate × lpFeeFraction × L_me / (L_b + L_me)
APR = Σ fees_b/day × 365 / capital
```

* `L_b`: liquidity of other LPs in the bin, rebuilt from the on-chain pool account + tick arrays (`liquidityNet` walk), via the
  shared RPC layer. Validation: valuing the whole rebuilt profile at the current price reproduces Raydium's TVL to 99–100% on
  all five listed pools, so units, decimals and `liquidityNet` signs are right.
* `L_me`: the liquidity `capital` buys in the range (CLMM maths, `clmm-liquidity.ts`). Capital is a fixed **$100** reference so the
  table and the modal always agree; larger deposits dilute themselves (shown in the tooltip).
* `volume_b`: average daily USD volume of the last **7 complete UTC days** (GeckoTerminal daily candles, the open day excluded
  like `/api/pool-daily-apr`; a pool younger than 7 days averages over its age; Raydium's 7d volume is the fallback) distributed over
  bins using hourly price candles. Hourly candles only supply the *shape*; USD volume comes from the daily series.
* `lpFeeFraction`: `1 − (protocolFeeRate + fundFeeRate)/1e6` from the Raydium pool config (0.84 on standard configs). Raydium's published
  `feeApr` is the gross trade fee, not what LPs keep.
* Time out of range earns nothing: volume that traded outside the range is not counted (`inRangeVolumePct` is returned and shown).

Two details matter and are tested:

1. **Rebasing.** Pool prices drift a few ticks per day, so "where did volume trade in absolute price" says little about where it will
   trade around the price you open at. Each UTC day's path is shifted so the day's first open sits at the current price: the result
   answers "if I had opened centred on the current price at the start of each recent day, how much of that day's volume would have
   traded in each bin?". Without it, narrow bands on drifting pools show ~0% in range (see the C0 column below).
2. **Volume cannot appear where there is no liquidity.** Inside a candle, volume is split across the bins it crossed in proportion to
   `L_bin × Δ√P` (the tokens needed to cross the bin). Empty bins get none, which stops a lone new LP from being handed 100% of
   the fees in a hole; volume that cannot be placed is reported as `unplacedVolumePct` and lowers confidence.

Fee noise: executed trade prices carry the swap fee, so candle ranges are shrunk by the fee rate on each side before measuring.

### Candidates compared (live data, 2026-10-11, $100 deposit)

A = pool-level Raydium-style `volume × fee × 365 / TVL` (not range aware). B = active-tick liquidity share, assuming 100% in range.
C0 = method C without rebasing. **C = chosen.** D = "naive concentration multiplier" on A.

| Pool (spacing, fee) | Raydium 24h / 7d APR | A (7d avg, LP-net) | Preset | B | C0 | **C** | in range | D |
|---|---|---|---|---|---|---|---|---|
| HOODx/HOOD (60, 25 bps) | 11.9% / 7.5% | 18.8% | AI pick (= Wide ticks) | 12.8% | 13.9% | **12.1%** | 92% | 3,150% |
| | | | Tight / Standard | 49.5 / 25.3% | 21.8 / 11.1% | **38.2 / 23.9%** | 77 / 92% | |
| SPCXx/SPCX (1, 1 bps, $283k) | 7.4% / 9.9% | 14.4% | AI pick | 354% | 0.2% | **154%** | 43% | 144,268% |
| | | | Tight / Standard / Wide | 142 / 24 / 7.2% | 0.3 / 6.4 / 3.4% | **113 / 23 / 7.0%** | 79 / 100 / 100% | |
| SPCXx/SPCX (1, 5 bps, $5.8k) | 5.9% / 9.8% | 14.7% | AI pick | 52% | 2.2% | **8.9%** (low conf.) | 17% | 147,308% |
| | | | Tight / Standard / Wide | 22 / 3.7 / 1.1% | 4.0 / 3.1 / 0.9% | **8.3 / 1.6 / 0.5%** | 38 / 43 / 43% | |
| INTCx/INTC (10, 10 bps) | 3.0% / 16.0% | 22.4% | AI pick | 124% | 74% | **82%** | 66% | 22,385% |
| | | | Tight / Standard / Wide | 229 / 73 / 25% | 76 / 64 / 25% | **79 / 66 / 25%** | 35 / 90 / 100% | |
| MSTRx/MSTR (1, 5 bps, $69k) | 0.2% / 4.2% | 6.3% | AI pick | 69% | 16% | **7.7%** | 11% | 62,726% |
| | | | Tight / Standard / Wide | 28 / 4.7 / 1.4% | 16 / 5.8 / 1.8% | **10.4 / 9.6 / 2.9%** | 36 / 100 / 100% | |

Why C:
* **A** is what Raydium shows and is the right *pool-wide* number, but identical for every range. Raydium's day APR is also a single
  day (839 USD of volume on HOODx/HOOD vs a $1,556 4-day average).
* **B** treats the price as sitting still, so narrow bands look like 100–350% on every pool. It ignores that the price leaves a 4-tick
  band within hours.
* **D** (pool APR × 1/(1−(Pa/Pb)^¼)) gives thousands of percent because it assumes the whole pool's volume trades inside your band
  against only your liquidity; it also ignores that the existing LPs are already concentrated. Rejected.
* **C0** shows the drift problem (SPCXx/SPCX 1 bps AI pick: 0.2% vs 154%).
* Volume cross-check: our 7-day average × 7 matches Raydium's 7-day volume to within 1–4% on all pools (e.g. SPCXx/SPCX 5 bps:
  $38.99k vs $37.76k), and on the large pool Raydium's published 30-day APR (11.4%) matches `30d volume × fee × 365/30 / TVL` (11.5%).
* Existing per-position fee APR on the performance page: the only live position found (SPCXx/SPCX 1 bps, 27-tick band, opened
  2026-06-22) realised **14.2%** over 111 days, mostly out of range and at a different volume level; it is not comparable to a
  forward estimate for a freshly centred band, but is the same order as C for Standard/Wide on that pool (23% / 7%).

## Assumptions and limits (also in the tooltip)

* Back-test, not a forecast: recent volume and today's liquidity repeat; other LPs do not move; one-day horizon after opening
  (positions are not re-centred; long holds drift out of range, see the per-preset in-range share).
* Excludes impermanent loss, rewards, swap costs and rent. Simple APR (not compounded). Dynamic-fee pools use the pool `feeRate`.
* Thin pools are noisy: a single day's volume can dominate (`confidence: "low"` when < 3 days, fallback sources, or > 30% of volume
  could not be placed on a bin with liquidity). The UI marks those with a caveat / asterisk.
* Window: ±max(300 raw ticks, 6 bins) around the price (≈ ±3–3.6%); ranges beyond it show "unavailable" rather than a guess.
* Only 4-bin-wide AI pick bands on spacing-1 pools are *very* narrow (≈ ±0.02%): the model puts only ~10–40% of volume inside, and
  on MSTRx/MSTR Tight/Standard out-earn it. The fixed rule is not the highest estimated APR on every pool.

## API

`GET /api/pool-range-apr?poolId=<clmm pool>` returns, per pool (cached 30 s at the CDN; per-instance upstream caches: Raydium+GeckoTerminal
30 min, on-chain state 30 s; in-flight de-duplication; 15 s negative cache; the browser fetches each pool once per minute and at most 2 at a time):

* `presets[]` (`ai`, `tight`, `standard`, `wide`): resolved ticks/prices and the priced estimate (`aprPct`, `inRangeVolumePct`);
* `model` (per-bin liquidity + daily volume, current sqrt price, USD per raw B): the input of the **pure** `estimateRangeApr`, which the
  browser runs for custom ranges so typing a price updates instantly with no request;
* `sample` (days, sources, unplaced volume, confidence), `published` (Raydium's own APR), `assumptions`, `sources`.

Reproduce the comparison: `npx tsx scripts/research-range-apr.ts [poolId …]` (read-only).
