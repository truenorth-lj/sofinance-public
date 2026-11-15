import "@/lib/engine-host";
import "server-only";
import { buildAndSimulateSelectedZap } from "@/lib/selected-atomic";
import type { BuildAdd } from "../add-prepare";

/** The single complete add build used by the app, MCP, preflight and raw-unit adapter. */
export const buildRaydiumAdd: BuildAdd = async (command, options) => {
  const { wallet, selection, amount, floorBps, toleranceBps } = command;
  return options
    ? buildAndSimulateSelectedZap(wallet, selection, amount, floorBps, toleranceBps, options)
    : buildAndSimulateSelectedZap(wallet, selection, amount, floorBps, toleranceBps);
};
