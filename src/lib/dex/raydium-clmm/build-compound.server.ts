import "@/lib/engine-host";
import "server-only";
import { getProtocolAdapter } from "@sofinance/engine/protocols/registry";
import type { BuildCompound } from "../compound-prepare";

export const buildRaydiumCompound: BuildCompound = ({ wallet, positionMint, sourceSignatures }) =>
  getProtocolAdapter("raydium-clmm").buildAndSimulateCompound(wallet, positionMint, sourceSignatures);
