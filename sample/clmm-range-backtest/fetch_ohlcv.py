"""Download this pool's OHLCV bars for price-only range research.

No wallet, RPC secret, or transaction signing is used. The fetched dataset has
no historical active-liquidity field, so it cannot produce fee backtests.
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import time
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import Request, urlopen


POOL_ID = "DUzBLHZ5RZdftPuWVijsvjupndogRM1adGJpsR7YTJro"
SPCX_MINT = "SPCXxcqXj6e5dJDVNovHN8744zkbhM2bYudU45BimGb"
API = f"https://api.geckoterminal.com/api/v2/networks/solana/pools/{POOL_ID}/ohlcv"


def get_page(timeframe: str, aggregate: int, currency: str, before: int | None,
             api_key: str | None) -> dict:
    """Request at most 1000 bars from GeckoTerminal's public API."""
    query = {"aggregate": aggregate, "limit": 1000, "currency": currency,
             "token": SPCX_MINT, "include_empty_intervals": "true"}
    if before is not None:
        query["before_timestamp"] = before
    request = Request(f"{API}/{timeframe}?{urlencode(query)}",
                      headers={"accept": "application/json"})
    if api_key:
        request.add_header("x-cg-demo-api-key", api_key)
    for attempt in range(4):
        try:
            with urlopen(request, timeout=30) as response:
                return json.load(response)
        except HTTPError as error:
            if error.code != 429 or attempt == 3:
                raise
            # Public GeckoTerminal requests share a small rolling rate limit.
            retry_after = error.headers.get("Retry-After")
            time.sleep(max(60.0, float(retry_after)) if retry_after else 60.0)
    raise RuntimeError("unreachable retry state")


def parse_page(payload: dict) -> dict[int, tuple[float, float, float, float, float]]:
    """Validate the documented [timestamp, open, high, low, close, volume] shape."""
    values = payload["data"]["attributes"]["ohlcv_list"]
    bars = {}
    for value in values:
        if len(value) != 6:
            raise ValueError("unexpected OHLCV response shape")
        timestamp, _open, high, low, close, volume = value
        bars[int(timestamp)] = (float(_open), float(high), float(low),
                                float(close), float(volume))
    return bars


def combine(relative: dict[int, tuple[float, float, float, float, float]],
            dollars: dict[int, tuple[float, float, float, float, float]]) -> list[dict]:
    """Join SPCX/SPCXx and SPCX/USD bars on identical time buckets.

    USD per SPCXx is derived from the pool ratio. This is pool-implied USD,
    not an independent executable quote or an issuer redemption value.
    """
    rows = []
    for timestamp in sorted(relative.keys() & dollars.keys()):
        _open, high, low, price_b_per_a, _relative_volume = relative[timestamp]
        _usd_open, _usd_high, _usd_low, usd_per_a, volume_usd = dollars[timestamp]
        if min(low, price_b_per_a, usd_per_a) <= 0 or high < price_b_per_a:
            raise ValueError(f"invalid OHLCV values at {timestamp}")
        rows.append({
            "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(timestamp)),
            "price_b_per_a": price_b_per_a,
            "usd_per_a": usd_per_a,
            "usd_per_b": usd_per_a / price_b_per_a,
            "low_b_per_a": low,
            "high_b_per_a": high,
            "volume_usd": volume_usd,
            "pool_liquidity_raw": "",
        })
    return rows


def main() -> None:
    """Fetch paired pages at a conservative public API request cadence."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--timeframe", choices=["minute", "hour", "day"], default="hour")
    parser.add_argument("--aggregate", type=int, default=1)
    parser.add_argument("--pages", type=int, default=1)
    parser.add_argument("--before-timestamp", type=int)
    args = parser.parse_args()
    if not 1 <= args.pages <= 20:
        parser.error("pages must be between 1 and 20")
    allowed_aggregates = {"minute": {1, 5, 15}, "hour": {1, 4, 12}, "day": {1}}
    if args.aggregate not in allowed_aggregates[args.timeframe]:
        parser.error("unsupported timeframe/aggregate combination")
    before = args.before_timestamp
    combined: dict[str, dict] = {}
    for page in range(args.pages):
        relative = parse_page(get_page(args.timeframe, args.aggregate, "token", before,
                                       os.environ.get("CG_DEMO_API_KEY")))
        time.sleep(3.1)
        dollars = parse_page(get_page(args.timeframe, args.aggregate, "usd", before,
                                      os.environ.get("CG_DEMO_API_KEY")))
        rows = combine(relative, dollars)
        if not rows:
            break
        combined.update({row["timestamp"]: row for row in rows})
        before = min(relative.keys() & dollars.keys()) - 1
        if page < args.pages - 1:
            time.sleep(3.1)
    if not combined:
        raise ValueError("provider returned no matching price bars")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("w", newline="", encoding="utf-8") as target:
        writer = csv.DictWriter(target, fieldnames=list(next(iter(combined.values()))))
        writer.writeheader()
        writer.writerows(combined[timestamp] for timestamp in sorted(combined))
    print(f"wrote {len(combined)} price bars to {args.output}; historical fees unavailable")


if __name__ == "__main__":
    main()
