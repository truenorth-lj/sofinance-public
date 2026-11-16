import "@/lib/engine-host";
import "server-only";
import { getProtocolAdapter } from "@sofinance/engine/protocols/registry";
import type { BuildOpen } from "../open-prepare";

export const buildRaydiumOpen: BuildOpen = (command, options) => {
  const { wallet, selection, amount, range, floorBps, toleranceBps, nftMint } = command;
  return getProtocolAdapter("raydium-clmm").buildAndSimulateOpenPosition(wallet, selection, amount, range, floorBps, toleranceBps,
    options ? { enforceResaleFloor: false, nftMint } : { nftMint });
};
