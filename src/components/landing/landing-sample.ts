/**
 * One 24h sample behind the landing's pair and returns sections: a simulated $1,000 position in the HOODx/HOOD
 * Raydium CLMM pool (Standard ±0.3% range), Oct 28 18:32 to Oct 29 18:30, 2026 (UTC+8), on real pool data.
 * Generated from the logger export (series.json); the pool price stayed in range for the whole window.
 * Rows: [hours since start, HOODx price in USD, value if just holding HOODx, pool position value, fees collected].
 * The logger paused between about 8.3h and 13.2h; charts draw that stretch as a dashed straight line.
 */
import { PLAN_SWAP_COST_BPS, planOpenCostPctLabel } from "@/lib/lp-plan-yield";

export type SampleRow = readonly [h: number, hoodxUsd: number, holdUsd: number, poolUsd: number, feesUsd: number];

export const SAMPLE_ROWS: readonly SampleRow[] = [
  [0.0, 87.298, 1000.0, 999.0, 0.0],
  [0.251, 87.403, 1001.2, 996.77, 0.0],
  [0.502, 87.89, 1006.78, 1002.97, 0.0],
  [0.767, 87.233, 999.26, 997.12, 0.0],
  [1.07, 87.556, 1002.96, 1001.07, 0.03],
  [1.327, 88.351, 1012.06, 1006.71, 0.03],
  [1.579, 88.332, 1011.85, 1011.84, 0.07],
  [1.839, 88.35, 1012.05, 1009.64, 0.07],
  [2.19, 88.304, 1011.53, 1008.74, 0.11],
  [2.443, 87.875, 1006.61, 1011.77, 0.11],
  [2.696, 88.288, 1011.34, 1009.75, 0.11],
  [2.947, 89.06, 1020.18, 1017.98, 0.11],
  [3.215, 91.277, 1045.58, 1042.87, 0.18],
  [3.464, 90.473, 1036.37, 1035.26, 0.21],
  [3.715, 91.435, 1047.39, 1045.27, 0.31],
  [3.972, 91.253, 1045.3, 1042.45, 0.35],
  [4.311, 92.115, 1055.19, 1053.23, 0.35],
  [4.564, 91.975, 1053.58, 1050.79, 0.35],
  [4.915, 92.145, 1055.53, 1053.86, 0.42],
  [5.166, 91.576, 1049.01, 1046.81, 0.43],
  [5.418, 90.825, 1040.41, 1037.58, 0.42],
  [5.679, 90.744, 1039.48, 1043.46, 4.51],
  [5.93, 90.263, 1033.97, 1037.22, 4.74],
  [6.268, 90.475, 1036.4, 1041.12, 5.03],
  [8.33, 91.615, 1049.45, 1052.62, 5.26],
  [13.247, 89.422, 1024.34, 1034.12, 5.43],
  [14.871, 89.384, 1023.89, 1030.45, 5.42],
  [15.566, 89.666, 1027.12, 1024.91, 5.4],
  [15.82, 89.272, 1022.62, 1023.34, 5.39],
  [16.071, 88.981, 1019.28, 1022.1, 5.38],
  [16.322, 88.928, 1018.68, 1022.33, 5.38],
  [16.573, 89.863, 1029.39, 1027.36, 5.41],
  [16.825, 89.059, 1020.18, 1022.85, 5.38],
  [17.076, 88.968, 1019.13, 1021.22, 5.37],
  [17.327, 88.968, 1019.13, 1021.22, 5.37],
  [17.577, 88.966, 1019.11, 1021.22, 5.37],
  [17.834, 89.199, 1021.78, 1022.15, 5.38],
  [18.086, 89.26, 1022.48, 1022.39, 5.38],
  [19.031, 89.806, 1028.73, 1024.57, 5.4],
  [19.282, 88.859, 1017.89, 1020.79, 5.37],
  [19.54, 89.791, 1028.56, 1030.42, 5.42],
  [19.791, 89.573, 1026.07, 1028.12, 5.41],
  [20.042, 89.468, 1024.87, 1027.21, 5.4],
  [20.293, 89.339, 1023.38, 1025.37, 5.4],
  [20.544, 89.339, 1023.38, 1025.37, 5.4],
  [20.795, 89.289, 1022.81, 1024.83, 5.39],
  [21.046, 89.806, 1028.74, 1028.51, 5.41],
  [21.297, 89.254, 1022.41, 1024.18, 5.39],
  [21.549, 89.108, 1020.73, 1022.48, 5.38],
  [21.8, 89.53, 1025.57, 1028.61, 5.41],
  [22.051, 89.572, 1026.05, 1028.92, 5.41],
  [22.302, 88.835, 1017.61, 1025.24, 5.39],
  [22.719, 89.952, 1030.4, 1033.46, 5.44],
  [22.971, 89.952, 1030.4, 1033.46, 5.44],
  [23.222, 89.643, 1026.86, 1032.22, 5.43],
  [23.473, 89.643, 1026.86, 1032.22, 5.43],
  [23.724, 89.643, 1026.86, 1032.22, 5.43],
  [23.975, 89.63, 1026.72, 1032.17, 5.43],
];

export const SAMPLE = {
  depositUsd: 1000,
  holdEndUsd: 1026.72,
  poolEndUsd: 1032.17,
  holdPct: 2.67,
  poolPct: 3.22,
  diffUsd: 5.45,
  feesUsd: 5.43,
  windowLabel: "Oct 28–29, 2026",
} as const;

/**
 * The calculator's swap-cost estimate (`PLAN_SWAP_COST_BPS`), the same figure it charges to open from USDC and to
 * close back to USDC. The landing sample leaves those costs out, so it states the figure from the same constant.
 */
export const SAMPLE_SWAP_COST_PCT = planOpenCostPctLabel(PLAN_SWAP_COST_BPS);

/** The sample is fees vs holding; opening and closing costs are left out and said so. */
export const SAMPLE_COSTS_NOTE =
  `Fees vs holding only. Opening and closing costs (about ${SAMPLE_SWAP_COST_PCT}% each way to and from USDC) are not included; ` +
  "over this one day they would be more than the fees.";

export const SAMPLE_FOOTNOTE = "Simulated $1,000 position on real pool data, not a prediction. One 24h sample.";

/** A gap between two rows longer than this is the logger pause, drawn dashed. */
export const SAMPLE_GAP_H = 1;
