"""Focused checks for tick math, volume ranking, and provider input."""

import csv
import tempfile
import unittest
from pathlib import Path

from backtest import liquidity_for_capital, rank_ranges, read_bars, tick_price
from fetch_ohlcv import combine, parse_page


class RangeBacktestTests(unittest.TestCase):
    def test_tick_price_accounts_for_unequal_mint_decimals(self):
        self.assertAlmostEqual(tick_price(46054, 6, 8), 1.0001**46054 / 100)

    def test_narrow_range_gets_more_liquidity_for_same_capital(self):
        narrow = liquidity_for_capital(1, 0.999, 1.001, 100, 100, 1000, 6, 8)
        wide = liquidity_for_capital(1, 0.99, 1.01, 100, 100, 1000, 6, 8)
        self.assertGreater(narrow, wide)

    def test_liquidity_matches_raydium_sdk_reference_snapshot(self):
        # Compared with TickUtil + LiquidityMathUtil.getAmountsForLiquidity:
        # this raw L consumes 1000.00003 USD after token-unit rounding.
        price = 1.0007272539671455
        usd_a = 147.54394915102517
        raw_l = liquidity_for_capital(
            price, tick_price(46049, 6, 8), tick_price(46062, 6, 8),
            usd_a, usd_a / price, 1000, 6, 8,
        )
        self.assertAlmostEqual(raw_l, 104344864104, delta=1000)

    def test_zero_volume_outside_range_prevents_narrow_range_winning(self):
        bars = [
            {"timestamp": "a", "price": 0.99, "usd_a": 100, "usd_b": 101,
             "volume": 10000},
            {"timestamp": "b", "price": 1.01, "usd_a": 100, "usd_b": 99,
             "volume": 10000},
            {"timestamp": "c", "price": 1.0, "usd_a": 100, "usd_b": 100,
             "volume": 0},
        ]
        ranked = rank_ranges(bars, 1000, 6, 8, 1, 200)
        self.assertGreater(ranked[0]["relative_score"], 0)
        self.assertTrue(any(row["upper_tick"] - row["lower_tick"] == 1
                            and row["eligible_volume_usd"] == 0 for row in ranked))

    def test_candidates_follow_tick_grid_and_exclude_out_of_range_today(self):
        bars = [{"timestamp": "a", "price": 1.0, "usd_a": 100,
                 "usd_b": 100, "volume": 1000}]
        ranked = rank_ranges(bars, 1000, 6, 8, 2, 4)
        self.assertEqual(len(ranked), 20)
        self.assertTrue(all(row["lower_tick"] % 2 == 0 for row in ranked))

    def test_odd_tick_widths_are_searched(self):
        bars = [{"timestamp": "a", "price": 1.0, "usd_a": 100,
                 "usd_b": 100, "volume": 1000}]
        ranked = rank_ranges(bars, 1000, 6, 8, 1, 4)
        self.assertTrue(any(row["upper_tick"] - row["lower_tick"] == 3
                            for row in ranked))

    def test_csv_rejects_duplicate_timestamps(self):
        record = {"timestamp": "2026-09-01T00:00:00Z", "price_b_per_a": 1,
                  "usd_per_a": 100, "usd_per_b": 100, "low_b_per_a": 1,
                  "high_b_per_a": 1, "volume_usd": 100}
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "bad.csv"
            with path.open("w", newline="") as target:
                writer = csv.DictWriter(target, fieldnames=record)
                writer.writeheader()
                writer.writerows([record, record])
            with self.assertRaisesRegex(ValueError, "timestamps must"):
                read_bars(path)

    def test_crossing_bar_is_possible_but_not_certain_volume(self):
        bars = [{"timestamp": "a", "price": 1.0, "low": 0.99,
                 "high": 1.01, "usd_a": 100, "usd_b": 100, "volume": 1000}]
        candidate = rank_ranges(bars, 1000, 6, 8, 1, 1)[0]
        self.assertEqual(candidate["fully_inside_bar_volume_usd"], 0)
        self.assertEqual(candidate["eligible_volume_usd"], 1000)
        self.assertEqual(candidate["overlapping_bar_volume_usd"], 1000)

    def test_live_anchor_reprices_pool_implied_token_b_usd(self):
        bars = [{"timestamp": "a", "price": 1.0, "usd_a": 100,
                 "usd_b": 100, "volume": 1000}]
        live_price = 1.001
        candidate = rank_ranges(bars, 1000, 6, 8, 1, 2,
                                current_price=live_price)[0]
        expected = liquidity_for_capital(
            live_price, candidate["lower_price_b_per_a"],
            candidate["upper_price_b_per_a"], 100, 100 / live_price,
            1000, 6, 8,
        )
        self.assertAlmostEqual(candidate["our_liquidity_raw"], expected)

    def test_provider_pairing_keeps_relative_and_dollar_prices_separate(self):
        relative = parse_page({"data": {"attributes": {
            "ohlcv_list": [[1000, 1.0, 1.02, 0.98, 1.01, 500]]}}})
        dollars = parse_page({"data": {"attributes": {
            "ohlcv_list": [[1000, 100, 105, 95, 101, 10000]]}}})
        row = combine(relative, dollars)[0]
        self.assertEqual(row["price_b_per_a"], 1.01)
        self.assertAlmostEqual(row["usd_per_b"], 100)
        self.assertEqual(row["volume_usd"], 10000)


if __name__ == "__main__":
    unittest.main()
