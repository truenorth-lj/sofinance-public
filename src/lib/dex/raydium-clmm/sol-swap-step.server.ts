import "@/lib/engine-host";
import "server-only";
import { buildAndSimulateSolSwapStep, readSolSwapDelivery } from "@sofinance/engine/sol-swap-step";
import type { BuildSolSwapStep, ReadSolSwapDelivery } from "../sol-swap-step";
export const buildRaydiumSolSwapStep: BuildSolSwapStep = ({ wallet, poolId, amount }) => buildAndSimulateSolSwapStep(wallet, poolId, amount);
export const readRaydiumSolSwapDelivery: ReadSolSwapDelivery = command => readSolSwapDelivery(command);
