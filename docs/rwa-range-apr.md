# Range APR estimate, Micro, and "Best"

Design note for the **Est. fee APR** shown in the Create position modal (`/app/rwa-pairs`), the **Best** preset, and the
**Highest range** column of the pairs table. Code: `src/lib/range-apr/`, `src/lib/pool-range-apr.ts`,
`src/app/api/pool-range-apr/route.ts`, UI in `src/components/range-apr/`. Web-only: the MCP `rangePreset` enum and
`recommendedRanges` are unchanged.

## Candidate ranges

Each pool is priced for four candidates (narrow to wide, the canonical order everywhere):

| Candidate | Definition |
|---|---|
| **Micro** | A fixed rule: centred on the current price, **±2 tick-spacing units (4 units wide)**. One "tick" here is one `tickSpacing` unit of the pool (distance between adjacent valid boundaries), not a raw 0.01% tick. `center` = valid boundary nearest to the pool's *exact* current tick (`2·ln(sqrtPrice)/ln(1.0001)`; ties to the lower one); `tickLower = center − 2·spacing`, `tickUpper = center + 2·spacing`, clamped into the usable range. Implemented once in `range-apr/micro-range.ts` and used by `resolveOpenRange`. |
| **Tight** | ±0.05% (existing percent preset) |
| **Standard** | ±0.3% (existing percent preset) |
| **Wide** | ±1% (existing percent preset) |

Spacing 1 → Micro ≈ ±0.02%; spacing 10 → ±0.2%; spacing 60 → ±1.2%, which on a 60-spaced pool is the same tick range as Wide.

## Best (the leftmost preset)

Not a prediction. It is **the candidate with the highest estimated fee APR** for this pool (from the last 7 complete days
of volume, see below), resolved by the pure functions in `range-apr/preset-list.ts` that the modal and the table both call:

* `pickHighestAprPreset` — highest `aprPct` among candidates with an estimate; ties (equal within float noise) go to the **wider** range
  (by tick width; between identical tick ranges, the later of Micro/Tight/Standard/Wide). Unavailable candidates are ignored.
* `buildPresetList` — the modal's row: `Best` (APR + small text with the range it resolved to, e.g. "Tight"), then the **other** candidates
  narrow→wide **without the resolved one**, then Custom. A candidate covering exactly the same ticks as the resolved one is also dropped, so no
  two buttons select the same range.
* Clicking Best selects the resolved candidate's own preset id, so `quote_open_position` / `prepare_open_position` receive e.g. `tight`
  and sign exactly the ticks that were priced. (Best itself is never sent to the API.)
* Default selection stays **Standard**. If Standard *is* what Best resolved to, Standard has no button of its own, so the default
  selection shows as the highlighted **Best** button (same ticks).
* While the estimate is loading, errored, or no candidate could be priced: the plain row `Micro, Tight, Standard, Wide, Custom`, no Best,
  no Best highlight (Standard remains the selected default).
* Tooltip copy: "The range with the highest estimated fee APR over the last 7 days for this pool … Not a prediction. A higher APR usually means a
  narrower range and a higher risk of leaving range."

## Highest range (pairs table column)

A new column after *Est. fee APR* showing, per pair, the candidate with the highest estimate and its APR, e.g. `Tight · ~38% APR`
(`*` = low-confidence sample; `…` while loading; `—` when nothing could be priced). It reads the same cached `/api/pool-range-apr` payload and
`highestRangeSummary` → `buildPresetList`, so it always equals the modal's Best. Labelled APR (not APY), same caveat tooltip. The table's
other columns are not sortable (rows are pre-ranked by the pool-level estimate), so this column is not either. On narrow screens the table
scrolls horizontally inside its wrapper; the cell never wraps.

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
C0 = method C without rebasing. **C = chosen.** D = "naive concentration multiplier" on A. **Bold in the last column = Best.**

| Pool (spacing, fee) | Raydium 24h / 7d APR | A (7d avg, LP-net) | Candidate | B | C0 | **C** | in range | D |
|---|---|---|---|---|---|---|---|---|
| HOODx/HOOD (60, 25 bps) | 11.9% / 7.5% | 18.8% | Micro (= Wide ticks) / Wide | 12.8% | 13.9% | 12% | 92% | 3,150% |
| | | | Tight / Standard | 49.5 / 25.3% | 21.8 / 11.1% | **38 (Tight)** / 24% | 77 / 92% | |
| SPCXx/SPCX (1, 1 bps, $283k) | 7.4% / 9.9% | 14.4% | Micro | 354% | 0.2% | **149 (Micro)** | 43% | 144,268% |
| | | | Tight / Standard / Wide | 142 / 24 / 7.2% | 0.3 / 6.4 / 3.4% | 108 / 23 / 6.8% | 79 / 100 / 100% | |
| SPCXx/SPCX (1, 5 bps, $5.8k) | 5.9% / 9.8% | 14.7% | Micro | 52% | 2.2% | **8.9 (Micro)**, low conf. | 17% | 147,308% |
| | | | Tight / Standard / Wide | 22 / 3.7 / 1.1% | 4.0 / 3.1 / 0.9% | 8.3 / 1.6 / 0.5% | 38 / 43 / 43% | |
| INTCx/INTC (10, 10 bps) | 3.0% / 16.0% | 22.4% | Micro | 124% | 74% | **82 (Micro)** | 66% | 22,385% |
| | | | Tight / Standard / Wide | 229 / 73 / 25% | 76 / 64 / 25% | 79 / 66 / 25% | 35 / 90 / 100% | |
| MSTRx/MSTR (1, 5 bps, $69k) | 0.2% / 4.2% | 6.3% | Micro | 69% | 16% | 7.7% | 11% | 62,726% |
| | | | Tight / Standard / Wide | 28 / 4.7 / 1.4% | 16 / 5.8 / 1.8% | **10 (Tight)** / 9.6 / 2.9% | 36 / 100 / 100% | |

Numbers move a little with each fetch (volume and liquidity are live); the resolution shown above is what the live build resolved to at the time.

Why C:
* **A** is what Raydium shows and is the right *pool-wide* number, but identical for every range. Raydium's day APR is also a single
  day (839 USD of volume on HOODx/HOOD vs a $1,556 4-day average).
* **B** treats the price as sitting still, so narrow bands look like 100–350% on every pool. It ignores that the price leaves a 4-tick
  band within hours.
* **D** (pool APR × 1/(1−(Pa/Pb)^¼)) gives thousands of percent because it assumes the whole pool's volume trades inside your band
  against only your liquidity; it also ignores that the existing LPs are already concentrated. Rejected.
* **C0** shows the drift problem (SPCXx/SPCX 1 bps Micro: 0.2% vs 149%).
* Volume cross-check: our 7-day average × 7 matches Raydium's 7-day volume to within 1–4% on all pools (e.g. SPCXx/SPCX 5 bps:
  $38.99k vs $37.76k), and on the large pool Raydium's published 30-day APR (11.4%) matches `30d volume × fee × 365/30 / TVL` (11.5%).
* Existing per-position fee APR on the performance page: the only live position found (SPCXx/SPCX 1 bps, 27-tick band, opened
  2026-06-22) realised **14.2%** over 111 days, mostly out of range and at a different volume level; it is not comparable to a
  forward estimate for a freshly centred band, but is the same order as C for Standard/Wide on that pool (23% / 7%).

## Degraded data: no price history means no estimate

Volume is placed on price bins from GeckoTerminal's hourly candles. If those are missing (rate limit, timeout, pool not indexed) the only
fallback left is "all volume at the current price", which hands the whole volume to the current bin and over-states narrow ranges badly
(live example: SPCXx/SPCX 5 bps showed Micro ~50% while the same pool with candles gives ~9%). A figure that changes 5x with which upstream
answered is worse than none, so:

* The server marks the payload `sample.degraded = true`, lists the cause in `sample.issues` (e.g. `GeckoTerminal hourly candles: Upstream
  request failed (429)`), and returns **every candidate as `unavailable` with reason `degraded-data`** (ranges are still resolved). No
  conservative bound is shown: any bound would still be a guess.
* The browser gates custom and quoted ranges the same way (`estimateForSelection`), so typing a custom price on a degraded pool shows no number.
* **Degraded estimates never take part in selection.** `buildPresetList` / `pickHighestAprPreset` ignore a degraded payload, so the modal shows the
  plain row (`Micro, Tight, Standard, Wide, Custom`, all `—`, no Best, no highlight) with "Recent price history is temporarily unavailable, so no
  estimate is shown", and the table's *Highest range* cell shows `—`.
* Missing *daily* volume alone (hourly candles fine) is not degraded: volume falls back to Raydium's 7-day figure and the estimate is flagged low confidence (`*`).
* Recovery: the server keeps a degraded profile for 10 s only (a good one for 30 min), retries rate-limited/5xx GeckoTerminal calls (3 attempts, 0.3-1.5 s
  backoff, never 404), limits GeckoTerminal to 2 concurrent calls per instance, and falls back to the last good price history of the same pool for up to
  6 h (stale-if-error). A degraded response is cached at the CDN for 5 s only, the browser keeps it 8 s and re-asks up to 3 times (10 s apart).

## Assumptions and limits (also in the tooltip)

* Back-test, not a forecast: recent volume and today's liquidity repeat; other LPs do not move; one-day horizon after opening
  (positions are not re-centred; long holds drift out of range, see the per-preset in-range share).
* Excludes impermanent loss, rewards, swap costs and rent. Simple APR (not compounded). Dynamic-fee pools use the pool `feeRate`.
* Thin pools are noisy: a single day's volume can dominate (`confidence: "low"` when < 3 days, fallback sources, or > 30% of volume
  could not be placed on a bin with liquidity). The UI marks those with a caveat / asterisk.
* Window: ±max(300 raw ticks, 6 bins) around the price (≈ ±3–3.6%); ranges beyond it show "unavailable" rather than a guess.
* Micro bands on spacing-1 pools are *very* narrow (≈ ±0.02%): the model puts only ~10–40% of volume inside, so they win on some pools
  (SPCXx/SPCX, INTCx/INTC) and lose on others (MSTRx/MSTR, HOODx/HOOD resolve to Tight). That is why Best is computed per pool instead of fixed.
* "Highest APR" is not "best": it ranks only by the estimate, which favours narrow ranges that leave range sooner. It is a ranking of an
  estimate, with the same low-confidence caveat on thin pools (e.g. the $5.8k SPCXx/SPCX pool).
* On pools where two candidates have identical ticks (HOODx/HOOD: Micro = Wide), both buttons can appear in the row when neither is Best.

## API

`GET /api/pool-range-apr?poolId=<clmm pool>` returns, per pool (cached 30 s at the CDN, 5 s when degraded; per-instance upstream caches: Raydium+GeckoTerminal
30 min (10 s when degraded), on-chain state 30 s; in-flight de-duplication; 15 s negative cache; the browser fetches each pool once per minute (8 s when degraded) and at most 2 at a time):

* `presets[]` (`micro`, `tight`, `standard`, `wide`): resolved ticks/prices and the priced estimate (`aprPct`, `inRangeVolumePct`);
* `model` (per-bin liquidity + daily volume, current sqrt price, USD per raw B): the input of the **pure** `estimateRangeApr`, which the
  browser runs for custom ranges so typing a price updates instantly with no request;
* `sample` (days, sources, unplaced volume, confidence, `degraded`, `issues`), `published` (Raydium's own APR), `assumptions`, `sources`.

Reproduce the comparison: `npx tsx scripts/research-range-apr.ts [poolId …]` (read-only).
