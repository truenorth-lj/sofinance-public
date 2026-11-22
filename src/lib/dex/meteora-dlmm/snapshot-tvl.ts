import { SPL_TOKEN_PROGRAM_ID } from "@sofinance/engine/protocols/meteora/constants";
import { scaledUiTvlUsd, type ScaledUiTvl } from "@sofinance/engine/valuation/pool-tvl";
import type { ScaledUiMultiplierConfig } from "@sofinance/engine/valuation/types";
import type { MeteoraPoolSnapshot } from "@/lib/meteora-daily-apr";
import { knownMultiplier, tvlLeavesOutScaledUi } from "@/lib/pool-tvl-scaled-ui";
import { FEED_KEY_METEORA, SOLANA_FEED_PROTOCOL } from "@/lib/rwa-store-types";

/**
 * What SoFinance already knows of a listed Meteora pool's two mints, for putting a datapi pool TVL in the registry
 * unit without a new read (X3-7 / X3-8): an allowlist entry pins each side's token program, and a feed row carries the
 * RWA scan's last mint read. X / Y are datapi's (LbPair) order; feed rows keep it (`mintA` = X, `mintB` = Y).
 */
export type MeteoraTvlMints = {
  tokenProgramX?: string;
  tokenProgramY?: string;
  /** The scan read both mints (`tvlScaledUi.mintsRead`); the configs below are then complete (absent = no extension). */
  mintsRead: boolean;
  scaledUiConfigX?: ScaledUiMultiplierConfig;
  scaledUiConfigY?: ScaledUiMultiplierConfig;
};

/**
 * datapi's pool TVL (`/pools/{address}`) in the registry unit: published TVL + the multiplier part. A side on the
 * original SPL Token program is 1 (no extensions possible); any other side needs the scan's mint read, else the
 * published TVL is kept and marked unverified (never treated as 1). `null` when datapi gave no TVL. Pure, no read.
 */
export function meteoraSnapshotTvl(
  snapshot: Pick<MeteoraPoolSnapshot, "tvlUsd" | "tvlSides">,
  mints: MeteoraTvlMints | undefined,
  nowMs: number,
): ScaledUiTvl | null {
  if (snapshot.tvlUsd === null) return null;
  if (!tvlLeavesOutScaledUi(SOLANA_FEED_PROTOCOL[FEED_KEY_METEORA])) return { kind: "corrected", tvlUsd: snapshot.tvlUsd, sourceTvlUsd: snapshot.tvlUsd };
  const multiplier = (program: string | undefined, config: ScaledUiMultiplierConfig | undefined) => program === SPL_TOKEN_PROGRAM_ID
    ? 1 : knownMultiplier({ known: mints?.mintsRead === true, config }, nowMs);
  const sides = snapshot.tvlSides;
  // No amounts in the answer: only a side known to be 1 without a read can count as verified.
  const blank = (program: string | undefined) => ({ amount: 0, sharePriceUsd: null, multiplier: program === SPL_TOKEN_PROGRAM_ID ? 1 : null });
  return scaledUiTvlUsd({ sourceTvlUsd: snapshot.tvlUsd, sides: sides
    ? [{ amount: sides.amountX, sharePriceUsd: sides.priceUsdX, multiplier: multiplier(mints?.tokenProgramX, mints?.scaledUiConfigX) },
      { amount: sides.amountY, sharePriceUsd: sides.priceUsdY, multiplier: multiplier(mints?.tokenProgramY, mints?.scaledUiConfigY) }]
    : [blank(mints?.tokenProgramX), blank(mints?.tokenProgramY)] });
}

/** The mints part of a Meteora feed row (`rwa-pairs` shape), as `meteoraSnapshotTvl` reads it. */
export function feedRowTvlMints(row: { tvlScaledUi?: { mintsRead: boolean }; scaledUiConfigA?: ScaledUiMultiplierConfig; scaledUiConfigB?: ScaledUiMultiplierConfig }):
  MeteoraTvlMints {
  return { mintsRead: row.tvlScaledUi?.mintsRead === true,
    ...(row.scaledUiConfigA ? { scaledUiConfigX: row.scaledUiConfigA } : {}), ...(row.scaledUiConfigB ? { scaledUiConfigY: row.scaledUiConfigB } : {}) };
}
