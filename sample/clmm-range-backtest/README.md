# SPCX/SPCXx Fixed Range Income Proxy Model

Goal: For the same entry capital, identify which Raydium CLMM price range could earn the most trading fees based on a simplified model of historical prices and volumes. This is an **exploratory ranking** that does not replay individual on-chain swaps and should not be treated as actual historical yield, expected returns, or APR. This example does not account for principal gains/losses, risk, rebalancing, position opening costs, or other rewards. Target pool: [SPCX/SPCXx pool](https://www.geckoterminal.com/solana/pools/DUzBLHZ5RZdftPuWVijsvjupndogRM1adGJpsR7YTJro); price represents how much SPCXx 1 SPCX is worth.

## Download and Execution

Execute in this folder, program only requires Python standard library:

```bash
python3 fetch_ohlcv.py --timeframe minute --aggregate 15 --pages 4 --output pool-15min.csv
python3 backtest.py pool-15min.csv --capital-usd 1000 --tick-spacing 1 \
  --max-side-ticks 100 --lookback-days 30 > ranking.json
python3 -m unittest -v test_backtest.py
```

The above execution only outputs **relative rankings**. To calculate dollar income proxy values, you must separately provide the pool's current price, active liquidity, and LP retention fee rate at the same point in time, such as the historical snapshot in the [audit report](results-20260929.md):

```bash
python3 backtest.py pool-15min.csv --as-of 2026-09-29T13:15:00Z \
  --lookback-days 30 --capital-usd 1000 --tick-spacing 1 \
  --max-side-ticks 100 --current-price 1.000254397251839 \
  --pool-liquidity-raw 7264072834616 --lp-fee-rate 0.000084
```

This command only reproduces the **historical snapshot scenario** from 2026-09-29 14:17 UTC; do not treat old current price and old liquidity as present state. `--as-of` cuts off historical bars, then uses `--lookback-days` to get the data window. Without `--current-price`, the program uses the latest bar's closing price as entry price. `--max-side-ticks 100` searches all legal upper/lower bound combinations within 100 ticks above and below the current price, including odd widths; this is not an unbounded global optimal search. The [Raydium pool API](https://api-v3.raydium.io/pools/info/ids?ids=DUzBLHZ5RZdftPuWVijsvjupndogRM1adGJpsR7YTJro) for this pool previously showed tick spacing 1, SPCX 6 decimals, SPCXx 8 decimals; re-verify before use.

The downloader uses the public GeckoTerminal [pool OHLCV API](https://coingecko-api-v3.readme.io/v3.0.1/reference/pool-ohlcv-contract-address): `currency=token` gets SPCXx/SPCX, `currency=usd` gets SPCX dollar price and volume; matched by timestamp, maximum 1000 bars per page. `--aggregate 15` means 15-minute bars. `CG_DEMO_API_KEY` is optional, public endpoints usually don't require it. Downloaded data like `pool-15min.csv` is not committed to Git. You can also use `synthetic-bars.csv` to test the program, but that file is synthetic data and cannot serve as historical evidence for this pool.

## Calculation Method and Boundaries

1. `tick_price = 1.0001^tick × 10^(decimals_A − decimals_B)`. Using fixed dollar investment amount and CLMM position formula to calculate the range's liquidity `L_ours`; position calculations have been verified against one Raydium SDK snapshot.
2. Each bar's **entire** dollar volume is judged whether it falls within the candidate range based on that bar's **closing relative price**. This simplification is especially sensitive for narrow ranges.
3. Without `--pool-liquidity-raw`, the score is `L_ours × historical volume falling in range`, with the highest normalized to 1. When that parameter is provided, the score becomes `historical volume falling in range × L_ours / (L_pool_snapshot + L_ours)`. Only with `--lp-fee-rate` is the **dollar income proxy value** calculated. This treats the **current** pool active liquidity as a constant throughout history and has no historical liquidity data.
4. `fully_inside_bar_volume_usd` and `overlapping_bar_volume_usd` respectively represent bar volumes where high/low prices are entirely within the range and where high/low prices touch the range. The corresponding fee columns are just **bar classification scenarios**, not strict upper/lower bounds for actual fees. Individual swaps may cross ticks, and the trading prices within the same bar and the active liquidity at each tick are unknown.

Therefore, rankings can only indicate "which segment scores higher in the above simplified model". To calculate true historical fees, you need to replay individual swap tick paths, volume at each step, pool active liquidity at that time, and fee distribution. Raydium's [fee documentation](https://github.com/raydium-io/raydium-docs-v1/blob/main/products/clmm/fees.mdx) also indicates that fees are distributed by swap step and active liquidity at that time.
