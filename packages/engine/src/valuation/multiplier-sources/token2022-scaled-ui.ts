import type { MultiplierHint, ScaledUiMultiplierConfig } from "../types";
import type { MultiplierSource } from "./types";

const CONFIG_ORIGIN_RANK = { snapshot: 0, jupiter: 1 } as const;

/**
 * Solana Token-2022 ScaledUiAmount. A mint account read in this request wins: with no extension it answers null and
 * leaves the mint to `spl-plain`. Without one, the stored snapshot config, then Jupiter's `scaledUiConfig`.
 */
export const token2022ScaledUiSource: MultiplierSource = {
  id: "token2022-scaled-ui",
  read(ref, hints) {
    if (ref.chain !== "solana") return null;
    const mint = hints.find((hint) => hint.kind === "mint-extensions");
    if (mint) return mint.scaledUiConfig ? { kind: "scaled-ui", config: mint.scaledUiConfig } : null;
    const config = hints
      .filter((hint): hint is Extract<MultiplierHint, { kind: "scaled-ui-config" }> => hint.kind === "scaled-ui-config")
      .sort((a, b) => CONFIG_ORIGIN_RANK[a.origin] - CONFIG_ORIGIN_RANK[b.origin])[0];
    return config ? { kind: "scaled-ui", config: config.config } : null;
  },
};

/** The extension config of an unpacked mint, as serializable numbers (timestamp in seconds). */
export function scaledUiConfigFromExtension(extension: {
  multiplier: number; newMultiplier: number; newMultiplierEffectiveTimestamp: bigint | number;
} | null): ScaledUiMultiplierConfig | null {
  if (!extension) return null;
  return {
    multiplier: Number(extension.multiplier),
    newMultiplier: Number(extension.newMultiplier),
    newMultiplierEffectiveTimestamp: Number(extension.newMultiplierEffectiveTimestamp),
  };
}
