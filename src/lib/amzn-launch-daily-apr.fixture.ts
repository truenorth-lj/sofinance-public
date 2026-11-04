import type { DailyAprPoint } from "./apr-series";

/**
 * Raydium AMZNx/AMZN 8ug1…tRfU (25 bps) as `/api/pool-daily-apr` served it on 2026-11-04 (points from 10-22 on): the
 * pool's first trading day, 10-29, had $8,397 of volume against $248 of TVL (3,089% for that day), then it went quiet.
 * 11-01 and 11-02 have no volume (gaps). The share calculator averaged the four finite days to 801% and compounded it
 * daily: 78,551.2% "APY" on $1,000.
 */
export const AMZN_LAUNCH_POOL = "8ug1sF47mzUxYhbnpGwYCf3bgb3TtrnwhABfdAfgtRfU";
export const AMZN_LAUNCH_TVL_USD = 1238.25;
const DAY = 86_400;
const OCT_22 = 1_792_627_200;
const row = (index: number, aprPct: number | null, volumeUsd: number | null, tvlUsd: number): DailyAprPoint => ({
  time: OCT_22 + index * DAY,
  date: new Date((OCT_22 + index * DAY) * 1000).toISOString().slice(0, 10),
  aprPct,
  volumeUsd,
  tvlUsd,
});
export const AMZN_LAUNCH_POINTS: DailyAprPoint[] = [
  row(0, null, null, 246),
  row(1, null, null, 246),
  row(2, null, null, 244),
  row(3, null, null, 243),
  row(4, null, null, 244),
  row(5, null, null, 244),
  row(6, null, null, 249),
  row(7, 3089.494548932432, 8396.653678194443, 248),
  row(8, 111.03020364324357, 1614.652934077635, 1327),
  row(9, 3.0028081256342105, 57.78554595741012, 1756),
  row(10, null, null, 1167),
  row(11, null, null, 1168),
  row(12, 0.7014556976479446, 9.193874130267854, 1196),
];
