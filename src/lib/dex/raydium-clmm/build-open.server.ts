import "@/lib/engine-host";
import "server-only";
import { getProtocolAdapter } from "@sofinance/engine/protocols/registry";
import { cachedOpenPoolState } from "@/lib/open-pool-snapshot";
import { rangeWithFairCenter } from "@/lib/open-range-center";
import type { BuildOpen } from "../open-prepare";

export const buildRaydiumOpen: BuildOpen = async (command, options) => {
  const { wallet, selection, amount, floorBps, toleranceBps, nftMint } = command;
  const snapshot = await cachedOpenPoolState(wallet, selection);
  const range = rangeWithFairCenter(command.range, snapshot);
  return getProtocolAdapter("raydium-clmm").buildAndSimulateOpenPosition(wallet, selection, amount, range, floorBps, toleranceBps,
    options ? { enforceResaleFloor: false, nftMint } : { nftMint });
};
