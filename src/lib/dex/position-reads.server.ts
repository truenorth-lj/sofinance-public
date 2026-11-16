import "server-only";
import { dexRegistry } from "./registry-instance";
import { DexUnsupportedError } from "./errors";
import { rangeStatusFromPrice } from "@/lib/position-range-status";
import type { NativePositionSource, PositionPerformanceCommand, PositionRangeCommand } from "./position-read";

/** Existing source precedence, with disabled venues never probed and probe errors preserved. */
export async function nativePositionSourceFor(positionMint: string): Promise<NativePositionSource> {
  for (const reader of dexRegistry.nativePositionReaders()) {
    if (reader.enabled() && await reader.matches(positionMint)) return reader.source;
  }
  throw new DexUnsupportedError();
}
function fallbackReader() {
  const reader = dexRegistry.nativePositionReaders().find(entry => entry.source === "raydium");
  if (!reader) throw new DexUnsupportedError();
  return reader;
}

export async function nativePositionPerformance(input: PositionPerformanceCommand) {
  const command = { ...input, ...(input.historyAfterSignatures ? { historyAfterSignatures: [...input.historyAfterSignatures] } : {}) };
  const source = await nativePositionSourceFor(command.positionMint);
  const reader = dexRegistry.nativePositionReaders().find(entry => entry.source === source);
  const options = { wallet: command.wallet, maxSignatures: command.maxSignatures, skipPricing: command.skipPricing,
    refreshHistory: command.refreshHistory, historyAfterSignatures: command.historyAfterSignatures };
  if (reader && reader.source !== "raydium" && reader.enabled()) {
    const result = await dexRegistry.readPositionPerformance(reader.id, command.positionMint, options);
    if (result) return { result, protocol: reader.protocol };
  }
  const result = await dexRegistry.readPositionPerformance(fallbackReader().id, command.positionMint, options);
  if (!result) throw new DexUnsupportedError();
  return { result, protocol: undefined };
}

export async function nativePositionRangeStatus(input: PositionRangeCommand) {
  const command = { ...input };
  const source = await nativePositionSourceFor(command.positionMint);
  const reader = dexRegistry.nativePositionReaders().find(entry => entry.source === source);
  const selected = reader && reader.source !== "raydium" && reader.enabled()
    ? await dexRegistry.readPositionRange(reader.id, command.positionMint) : null;
  const facts = selected ?? await dexRegistry.readPositionRange(fallbackReader().id, command.positionMint);
  if (!facts) throw new DexUnsupportedError();
  const status = rangeStatusFromPrice({ priceBPerA: facts.onChainPriceBPerA, tickLower: facts.tickLower, tickUpper: facts.tickUpper,
    decimalsA: facts.decimalsA, decimalsB: facts.decimalsB, priceSource: "on-chain" });
  return {
    ...(selected && source === "orca" ? { protocol: reader!.protocol } : {}),
    wallet: command.wallet ?? null,
    ...facts,
    ...(selected && source === "meteora" ? { protocol: reader!.protocol } : {}),
    poolId: command.poolId ?? facts.poolId,
    ...status,
  };
}
