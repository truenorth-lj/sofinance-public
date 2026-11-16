/** Type-only native refresh context/statistics; runtime state stays in the DEX implementation. */
export type NativeAprRunInput = Parameters<typeof import("./dex/uniswap-v4-rhc/apr-refresh.server").prepareRhcRun>[0];
export type { RhcAprRunStats as NativeAprRunStats } from "./dex/uniswap-v4-rhc/apr-refresh.server";
