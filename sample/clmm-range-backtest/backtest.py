"""Rank today's fixed CLMM ranges using this pool's historical OHLCV."""

from __future__ import annotations

import argparse
import csv
import json
import math
from datetime import datetime, timedelta
from pathlib import Path


TICK_BASE = 1.0001


def read_bars(path: Path) -> list[dict]:
    """Read the fetcher's output, rejecting missing or unordered observations."""
    required = {"timestamp", "price_b_per_a", "usd_per_a", "usd_per_b",
                "low_b_per_a", "high_b_per_a", "volume_usd"}
    with path.open(newline="", encoding="utf-8") as source:
        reader = csv.DictReader(source)
        if not reader.fieldnames or not required.issubset(reader.fieldnames):
            raise ValueError(f"missing CSV columns: {sorted(required)}")
        result = []
        previous = None
        for line, row in enumerate(reader, 2):
            try:
                timestamp = datetime.fromisoformat(row["timestamp"].replace("Z", "+00:00"))
                price = float(row["price_b_per_a"])
                usd_a = float(row["usd_per_a"])
                usd_b = float(row["usd_per_b"])
                low = float(row["low_b_per_a"])
                high = float(row["high_b_per_a"])
                volume = float(row["volume_usd"])
            except (KeyError, TypeError, ValueError) as error:
                raise ValueError(f"invalid row {line}: {error}") from error
            if timestamp.tzinfo is None or (previous and timestamp <= previous):
                raise ValueError(f"row {line}: timestamps must be timezone-aware and increasing")
            if not all(math.isfinite(value) for value in (price, usd_a, usd_b, low, high, volume)):
                raise ValueError(f"row {line}: non-finite number")
            if min(price, usd_a, usd_b, low) <= 0 or low > price or price > high or volume < 0:
                raise ValueError(f"row {line}: invalid OHLCV prices or volume")
            result.append({"timestamp": row["timestamp"], "price": price,
                           "usd_a": usd_a, "usd_b": usd_b, "low": low,
                           "high": high, "volume": volume})
            previous = timestamp
    if not result:
        raise ValueError("empty OHLCV file")
    return result


def tick_price(tick: int, decimals_a: int, decimals_b: int) -> float:
    """Convert a raw token-B/token-A Raydium tick to displayed B/A price."""
    return TICK_BASE**tick * 10 ** (decimals_a - decimals_b)


def liquidity_for_capital(price: float, lower: float, upper: float,
                          usd_a: float, usd_b: float, capital_usd: float,
                          decimals_a: int, decimals_b: int) -> float:
    """Continuous CLMM liquidity obtained from equal USD capital at today's price."""
    raw_scale = 10 ** (decimals_b - decimals_a)
    sqrt_price = math.sqrt(max(lower, min(price, upper)) * raw_scale)
    sqrt_lower = math.sqrt(lower * raw_scale)
    sqrt_upper = math.sqrt(upper * raw_scale)
    a_per_l = (1 / sqrt_price - 1 / sqrt_upper) / 10**decimals_a
    b_per_l = (sqrt_price - sqrt_lower) / 10**decimals_b
    return capital_usd / (a_per_l * usd_a + b_per_l * usd_b)


def rank_ranges(bars: list[dict], capital_usd: float, decimals_a: int,
                decimals_b: int, tick_spacing: int, max_side_ticks: int,
                pool_liquidity_raw: float | None = None,
                current_price: float | None = None) -> list[dict]:
    """Score historical volume at each bar close for today's fixed candidate range.

    Without pool liquidity, score is volume * our liquidity, normalized to
    the winner. With a constant pool liquidity scenario, score is volume *
    our estimated active-liquidity share. Neither is a realized-fee replay.
    """
    if not bars or not math.isfinite(capital_usd) or capital_usd <= 0:
        raise ValueError("invalid bars or capital")
    if tick_spacing <= 0 or max_side_ticks <= 0 or decimals_a < 0 or decimals_b < 0:
        raise ValueError("invalid tick spacing, search radius, or mint decimals")
    if pool_liquidity_raw is not None and (
        not math.isfinite(pool_liquidity_raw) or pool_liquidity_raw < 0
    ):
        raise ValueError("pool liquidity must be nonnegative")
    now = bars[-1]
    today_price = now["price"] if current_price is None else current_price
    if not math.isfinite(today_price) or today_price <= 0:
        raise ValueError("current price must be positive")
    raw_now = today_price * 10 ** (decimals_b - decimals_a)
    base_tick = math.floor(math.log(raw_now) / math.log(TICK_BASE) / tick_spacing) * tick_spacing
    # Correct floating-point log rounding at an exact tick boundary.
    while tick_price(base_tick + tick_spacing, decimals_a, decimals_b) <= today_price:
        base_tick += tick_spacing
    while tick_price(base_tick, decimals_a, decimals_b) > today_price:
        base_tick -= tick_spacing
    total_volume = sum(bar["volume"] for bar in bars)
    current_usd_b = now["usd_a"] / today_price if current_price is not None else now["usd_b"]
    results = []
    for lower_steps in range(max_side_ticks + 1):
        for upper_steps in range(1, max_side_ticks + 1):
            lower_tick = base_tick - lower_steps * tick_spacing
            upper_tick = base_tick + upper_steps * tick_spacing
            lower = tick_price(lower_tick, decimals_a, decimals_b)
            upper = tick_price(upper_tick, decimals_a, decimals_b)
            if not lower <= today_price < upper:
                continue
            # The fetched B/USD mark is pool-implied; reconcile it to the
            # separately supplied live B/A price before sizing today's deposit.
            our_liquidity = liquidity_for_capital(
                today_price, lower, upper, now["usd_a"], current_usd_b,
                capital_usd, decimals_a, decimals_b,
            )
            eligible_volume = sum(bar["volume"] for bar in bars
                                  if lower <= bar["price"] < upper)
            # These are bar-selection scenarios, not rigorous fee bounds:
            # a swap can cross ticks within a single recorded trade.
            fully_inside_volume = sum(bar["volume"] for bar in bars
                                      if lower <= bar.get("low", bar["price"])
                                      and bar.get("high", bar["price"]) < upper)
            overlapping_volume = sum(bar["volume"] for bar in bars
                                     if bar.get("high", bar["price"]) >= lower
                                     and bar.get("low", bar["price"]) < upper)
            in_range_bars = sum(lower <= bar["price"] < upper for bar in bars)
            share_or_liquidity = (
                our_liquidity / (pool_liquidity_raw + our_liquidity)
                if pool_liquidity_raw is not None else our_liquidity
            )
            results.append({
                "lower_tick": lower_tick, "upper_tick": upper_tick,
                "lower_price_b_per_a": lower, "upper_price_b_per_a": upper,
                "eligible_volume_usd": eligible_volume,
                "fully_inside_bar_volume_usd": fully_inside_volume,
                "overlapping_bar_volume_usd": overlapping_volume,
                "volume_capture_fraction": eligible_volume / total_volume if total_volume else 0,
                "in_range_bar_fraction": in_range_bars / len(bars),
                "our_liquidity_raw": our_liquidity,
                "score": eligible_volume * share_or_liquidity,
            })
    results.sort(key=lambda item: item["score"], reverse=True)
    if results and pool_liquidity_raw is None and results[0]["score"]:
        best_score = results[0]["score"]
        for result in results:
            result["relative_score"] = result.pop("score") / best_score
    return results


def main() -> None:
    """Print a ranked income proxy, with no risk or rebalance model."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("csv", type=Path)
    parser.add_argument("--capital-usd", type=float, required=True)
    parser.add_argument("--tick-spacing", type=int, required=True,
                        help="verify this pool's live AmmConfig first")
    parser.add_argument("--decimals-a", type=int, default=6)
    parser.add_argument("--decimals-b", type=int, default=8)
    parser.add_argument("--max-side-ticks", type=int, default=100,
                        help="search every legal bound within this many ticks of today's price")
    parser.add_argument("--pool-liquidity-raw", type=float,
                        help="optional constant active-liquidity scenario, not historical fact")
    parser.add_argument("--lp-fee-rate", type=float,
                        help="LP-retained share of traded USD volume; requires pool liquidity")
    parser.add_argument("--current-price", type=float,
                        help="fresh Raydium B/A price; default is latest OHLCV close")
    parser.add_argument("--lookback-days", type=float,
                        help="use only the final N days; default is all available bars")
    parser.add_argument("--as-of", help="ISO 8601 UTC cutoff for historical bars")
    parser.add_argument("--top", type=int, default=10,
                        help="number of highest-ranked ranges to print")
    args = parser.parse_args()
    if args.top <= 0:
        parser.error("top must be positive")
    bars = read_bars(args.csv)
    if args.as_of:
        try:
            as_of = datetime.fromisoformat(args.as_of.replace("Z", "+00:00"))
        except ValueError:
            parser.error("as-of must be an ISO 8601 timestamp")
        if as_of.tzinfo is None:
            parser.error("as-of must include a timezone")
        bars = [bar for bar in bars if datetime.fromisoformat(
            bar["timestamp"].replace("Z", "+00:00")) <= as_of]
        if not bars:
            parser.error("no bars at or before as-of")
    if args.lp_fee_rate is not None and (
        args.pool_liquidity_raw is None or not 0 <= args.lp_fee_rate < 1
    ):
        parser.error("LP fee rate requires pool liquidity and must be in [0, 1)")
    if args.lookback_days is not None:
        if not math.isfinite(args.lookback_days) or args.lookback_days <= 0:
            parser.error("lookback days must be positive")
        latest = datetime.fromisoformat(bars[-1]["timestamp"].replace("Z", "+00:00"))
        cutoff = latest - timedelta(days=args.lookback_days)
        bars = [bar for bar in bars if datetime.fromisoformat(
            bar["timestamp"].replace("Z", "+00:00")) >= cutoff]
    ranked = rank_ranges(bars, args.capital_usd, args.decimals_a, args.decimals_b,
                         args.tick_spacing, args.max_side_ticks,
                         args.pool_liquidity_raw, args.current_price)
    if args.lp_fee_rate is not None:
        for candidate in ranked:
            candidate["estimated_gross_lp_fee_usd"] = candidate["score"] * args.lp_fee_rate
            share = candidate["our_liquidity_raw"] / (
                args.pool_liquidity_raw + candidate["our_liquidity_raw"]
            )
            candidate["fee_fully_inside_bars_usd"] = (
                candidate["fully_inside_bar_volume_usd"] * share * args.lp_fee_rate
            )
            candidate["fee_overlapping_bars_usd"] = (
                candidate["overlapping_bar_volume_usd"] * share * args.lp_fee_rate
            )
    print(json.dumps({"bars": len(bars), "first": bars[0]["timestamp"],
                      "last": bars[-1]["timestamp"],
                      "anchor_price_b_per_a": args.current_price or bars[-1]["price"],
                      "anchor_source": "supplied_current_price" if args.current_price is not None
                      else "latest_ohlcv_close",
                      "score_type": "volume_share_proxy" if args.pool_liquidity_raw is not None
                      else "relative_volume_times_liquidity_proxy",
                      "candidate_count": len(ranked),
                      "ranked": ranked[:args.top]}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
