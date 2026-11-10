import "@/lib/engine-host";
/**
 * Re-price range APR candidates for the amount the user typed (pure, browser-safe). The per-pool
 * payload ships the whole APR model, so this does not make another request. Ranking uses the
 * re-priced estimates and the pool-fee cap; it does not exclude ranges by deposit size.
 */
import { estimateRangeApr } from "./range-apr";
import { toRangeAprInputs } from "./selection";
import type { PoolRangeAprPayload } from "./types";

/**
 * The payload re-priced for `capitalUsd`: every candidate's estimate uses that capital (own liquidity is
 * already part of the fee share in `estimateRangeApr`). Without a usable amount, or for a degraded
 * payload, the server's reference-capital payload is returned unchanged.
 */
export function payloadForCapital(payload: PoolRangeAprPayload, capitalUsd: number | null | undefined): PoolRangeAprPayload {
  if (!capitalUsd || !Number.isFinite(capitalUsd) || capitalUsd <= 0 || payload.sample.degraded) return payload;
  const inputs = { ...toRangeAprInputs(payload), capitalUsd };
  return {
    ...payload,
    referenceCapitalUsd: capitalUsd,
    presets: payload.presets.map((preset) => ({
      ...preset,
      estimate: estimateRangeApr(inputs, preset),
    })),
  };
}

/**
 * USD value of the typed amount for the selected input asset, or null when it cannot be valued (the
 * estimate then stays at the reference capital). Pool tokens are valued from the payload's own model.
 */
export function depositUsd(input: {
  amount: number | null; inputMint: string | null; inputKind: "native" | "token";
  usdcMint: string; wsolMint: string; solUsd: number | null;
  mintA: string; mintB: string; payload: PoolRangeAprPayload | null;
}): number | null {
  const { amount, inputMint, payload } = input;
  if (amount === null || !(amount > 0) || !inputMint) return null;
  if (input.inputKind === "token" && inputMint === input.usdcMint) return amount;
  if (input.inputKind === "native" || inputMint === input.wsolMint) return input.solUsd && input.solUsd > 0 ? amount * input.solUsd : null;
  if (!payload || !(payload.model.usdPerRawB > 0)) return null;
  const usdPerB = payload.model.usdPerRawB * 10 ** payload.pool.decimalsB;
  if (inputMint === input.mintB) return amount * usdPerB;
  if (inputMint === input.mintA) return payload.pool.currentPrice > 0 ? amount * payload.pool.currentPrice * usdPerB : null;
  return null;
}
