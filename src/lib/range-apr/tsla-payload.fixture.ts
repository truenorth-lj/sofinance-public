import type { PoolRangeAprPayload } from "./types";

/** /api/pool-range-apr for TSLA/TSLAx (Dk8jvXxpjdNEHQWXHcW1uKpUFTyhkAuSxqonqAv7d9sD) as served on 2026-10-21. */
export const tslaPayload: PoolRangeAprPayload = {
  "pool": {
    "tvlUsd": 1947.41,
    "feeRate": 0.0025,
    "decimalsA": 6,
    "decimalsB": 8,
    "tickCurrent": 46069,
    "tickSpacing": 60,
    "currentPrice": 1.000982306262105,
    "lpFeeFraction": 0.84
  },
  "label": "Est. fee APR",
  "model": {
    "bins": [
      {
        "tick": 45660,
        "liquidity": 0,
        "volumeUsd": 0
      },
      {
        "tick": 45720,
        "liquidity": 0,
        "volumeUsd": 0
      },
      {
        "tick": 45780,
        "liquidity": 0,
        "volumeUsd": 0
      },
      {
        "tick": 45840,
        "liquidity": 2455411438,
        "volumeUsd": 0
      },
      {
        "tick": 45900,
        "liquidity": 2455411438,
        "volumeUsd": 0
      },
      {
        "tick": 45960,
        "liquidity": 2455411438,
        "volumeUsd": 0
      },
      {
        "tick": 46020,
        "liquidity": 10559826080,
        "volumeUsd": 6.566410236238381
      },
      {
        "tick": 46080,
        "liquidity": 2455411438,
        "volumeUsd": 0
      },
      {
        "tick": 46140,
        "liquidity": 2455411438,
        "volumeUsd": 0
      },
      {
        "tick": 46200,
        "liquidity": 2455411438,
        "volumeUsd": 0
      },
      {
        "tick": 46260,
        "liquidity": 0,
        "volumeUsd": 0
      },
      {
        "tick": 46320,
        "liquidity": 0,
        "volumeUsd": 0
      },
      {
        "tick": 46380,
        "liquidity": 0,
        "volumeUsd": 0
      }
    ],
    "usdPerRawB": 3.7947614659113227e-06,
    "currentSqrt": 10.007967024217294,
    "avgDailyVolumeUsd": 6.566410236238381
  },
  "poolId": "Dk8jvXxpjdNEHQWXHcW1uKpUFTyhkAuSxqonqAv7d9sD",
  "sample": {
    "days": 7,
    "issues": [
      "GeckoTerminal daily candles: no complete days",
      "no trades in the sample window"
    ],
    "degraded": false,
    "confidence": "low",
    "candleCount": 0,
    "volumeSource": "raydium-7d",
    "windowEndUtc": "2026-10-21T00:00:00.000Z",
    "windowStartUtc": "2026-10-14T00:00:00.000Z",
    "occupancySource": "current-price",
    "unplacedVolumePct": 0
  },
  "presets": [
    {
      "id": "micro",
      "estimate": {
        "aprPct": 0.10276513302225355,
        "status": "ok",
        "feesPerDayUsd": 0.00028154830965000974,
        "inRangeVolumePct": 100
      },
      "tickLower": 45960,
      "tickUpper": 46200,
      "priceLower": 0.9906440709498762,
      "priceUpper": 1.01470591278305
    },
    {
      "id": "tight",
      "estimate": {
        "aprPct": 0.3866425725371837,
        "status": "ok",
        "feesPerDayUsd": 0.0010592947192799554,
        "inRangeVolumePct": 100
      },
      "tickLower": 46020,
      "tickUpper": 46080,
      "priceLower": 0.9966055037238322,
      "priceUpper": 1.0026028108160832
    },
    {
      "id": "standard",
      "estimate": {
        "aprPct": 0.20113226186613548,
        "status": "ok",
        "feesPerDayUsd": 0.0005510472927839328,
        "inRangeVolumePct": 100
      },
      "tickLower": 46020,
      "tickUpper": 46140,
      "priceLower": 0.9966055037238322,
      "priceUpper": 1.0086362081087439
    },
    {
      "id": "wide",
      "estimate": {
        "aprPct": 0.10276513302225355,
        "status": "ok",
        "feesPerDayUsd": 0.00028154830965000974,
        "inRangeVolumePct": 100
      },
      "tickLower": 45960,
      "tickUpper": 46200,
      "priceLower": 0.9906440709498762,
      "priceUpper": 1.01470591278305
    }
  ],
  "sources": [
    "https://api-v3.raydium.io/pools/info/ids (feeRate, TVL, token amounts, fee cuts)",
    "https://api.geckoterminal.com/api/v2/networks/solana/pools/{pool}/ohlcv/hour (price path, token currency)",
    "Solana RPC: CLMM pool account + tick arrays (liquidity per price bin)"
  ],
  "fetchedAt": "2026-10-21T12:02:30.000Z",
  "published": {
    "dayFeeApr": 2.15,
    "weekFeeApr": 0.18
  },
  "assumptions": "Estimate, not a guarantee. Back-tests the last 7 complete UTC days of pool volume (GeckoTerminal, current day excluded) against the pool's liquidity right now (on-chain tick arrays). Fees = volume that traded inside your range \u00d7 pool fee rate \u00d7 the share LPs keep (Raydium keeps protocol + fund cuts) \u00d7 your share of the liquidity in each price bin. Volume only counts while the price is inside your range, using hourly price history; time out of range earns nothing. Assumes volume, other LPs' liquidity and prices behave like the recent past. Excludes impermanent loss, rewards, swap and rent costs. Rate shown for a ~$100 deposit; larger deposits dilute their own share of the fees.",
  "referenceCapitalUsd": 100,
  "freshness": {
    "snapshotAt": "2026-10-21T12:02:30.000Z",
    "chainObservedAt": "2026-10-21T12:02:30.896Z",
    "economicsObservedAt": "2026-10-21T11:36:00.852Z",
    "volumeObservedAt": "2026-10-21T11:36:01.252Z",
    "stale": false,
    "lastAttemptStatus": "ok"
  }
};
