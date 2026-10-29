import { PublicKey } from "@solana/web3.js";
import { BIN_ARRAY_DISCRIMINATOR, METEORA_BINS_PER_ARRAY, meteoraBinArrayIndex, type MeteoraBinArray } from "./accounts";

/**
 * Read-only Meteora DLMM `PositionV2` decoding and position math (no SDK dependency).
 * A DLMM position is a program account owned by a wallet, not an NFT. Layout follows
 * the `lb_clmm` IDL shipped with `@meteora-ag/dlmm` 1.9.14; amounts and uncollected fees
 * follow its `DLMM.processPosition` (parity-tested on a mainnet capture). Rewards are
 * ignored (the allowlisted pools have none). Nothing here builds or signs transactions.
 */

/** sha256("account:PositionV2")[0..8]. */
export const METEORA_POSITION_V2_DISCRIMINATOR = "75b0d4c7f5b485b6";
/** Bins stored in the base account; wider positions append `POSITION_BIN_DATA_LEN` bytes per extra bin. */
export const METEORA_POSITION_BASE_BINS = 70;
export const METEORA_POSITION_BASE_LEN = 8120;
const POSITION_BIN_DATA_LEN = 112;
/** Max position width after `increase_position_length`. */
export const METEORA_POSITION_MAX_BINS = 1400;
/** Byte offsets used for getProgramAccounts memcmp filters. */
export const METEORA_POSITION_LB_PAIR_OFFSET = 8;
export const METEORA_POSITION_OWNER_OFFSET = 40;

const SHARES_OFFSET = 72;
const REWARD_INFOS_OFFSET = SHARES_OFFSET + 16 * 70; // 1192, 48 bytes each
const FEE_INFOS_OFFSET = REWARD_INFOS_OFFSET + 48 * 70; // 4552, 48 bytes each
const SCALE_OFFSET = 64n;
const BIN_LEN = 144;
const BIN_ARRAY_HEADER_LEN = 56;

export type MeteoraPositionBin = {
  binId: number;
  /** Liquidity share, scaled by 2^64 (v2). */
  liquidityShare: bigint;
  feeXPerTokenComplete: bigint;
  feeYPerTokenComplete: bigint;
  feeXPending: bigint;
  feeYPending: bigint;
};

export type MeteoraPosition = {
  lbPair: string;
  owner: string;
  lowerBinId: number;
  upperBinId: number;
  lastUpdatedAt: number;
  totalClaimedFeeX: bigint;
  totalClaimedFeeY: bigint;
  operator: string;
  feeOwner: string;
  bins: MeteoraPositionBin[];
};

const view = (data: Uint8Array) => new DataView(data.buffer, data.byteOffset, data.byteLength);
const key = (data: Uint8Array, offset: number) => new PublicKey(data.subarray(offset, offset + 32)).toBase58();
function u128(v: DataView, offset: number): bigint {
  return v.getBigUint64(offset, true) | (v.getBigUint64(offset + 8, true) << 64n);
}

export function isMeteoraPositionAccount(data: Uint8Array): boolean {
  return data.length >= METEORA_POSITION_BASE_LEN && Buffer.from(data.subarray(0, 8)).toString("hex") === METEORA_POSITION_V2_DISCRIMINATOR;
}

/** Decode a `PositionV2` account, including extended bins appended after the base account. */
export function decodeMeteoraPosition(data: Uint8Array): MeteoraPosition {
  if (!isMeteoraPositionAccount(data)) throw new Error("Not a Meteora DLMM position account");
  const v = view(data);
  const lowerBinId = v.getInt32(7912, true);
  const upperBinId = v.getInt32(7916, true);
  const width = upperBinId - lowerBinId + 1;
  if (width < 1 || width > METEORA_POSITION_MAX_BINS) throw new Error("Meteora position bin range is invalid");
  const extra = Math.max(0, width - METEORA_POSITION_BASE_BINS);
  if (data.length < METEORA_POSITION_BASE_LEN + extra * POSITION_BIN_DATA_LEN) throw new Error("Meteora position account is truncated");
  const bins: MeteoraPositionBin[] = [];
  for (let i = 0; i < width; i++) {
    // Base bins: parallel arrays. Extended bins: { share u128, UserRewardInfo 48, FeeInfo 48 } records.
    const ext = METEORA_POSITION_BASE_LEN + (i - METEORA_POSITION_BASE_BINS) * POSITION_BIN_DATA_LEN;
    const shareAt = i < METEORA_POSITION_BASE_BINS ? SHARES_OFFSET + 16 * i : ext;
    const feeAt = i < METEORA_POSITION_BASE_BINS ? FEE_INFOS_OFFSET + 48 * i : ext + 16 + 48;
    bins.push({
      binId: lowerBinId + i,
      liquidityShare: u128(v, shareAt),
      feeXPerTokenComplete: u128(v, feeAt),
      feeYPerTokenComplete: u128(v, feeAt + 16),
      feeXPending: v.getBigUint64(feeAt + 32, true),
      feeYPending: v.getBigUint64(feeAt + 40, true),
    });
  }
  return {
    lbPair: key(data, 8),
    owner: key(data, 40),
    lowerBinId,
    upperBinId,
    lastUpdatedAt: Number(v.getBigInt64(7920, true)),
    totalClaimedFeeX: v.getBigUint64(7928, true),
    totalClaimedFeeY: v.getBigUint64(7936, true),
    operator: key(data, 7960),
    feeOwner: key(data, 8001),
    bins,
  };
}

export type MeteoraBinFeeGrowth = { amountX: bigint; amountY: bigint; liquiditySupply: bigint; feeXPerTokenStored: bigint; feeYPerTokenStored: bigint };

/** Reserves, supply and fee-per-token accumulators of one bin from its raw bin array account. */
export function readMeteoraBinFeeGrowth(binArrayData: Uint8Array, binId: number): MeteoraBinFeeGrowth {
  if (binArrayData.length < BIN_ARRAY_HEADER_LEN + METEORA_BINS_PER_ARRAY * BIN_LEN ||
      Buffer.from(binArrayData.subarray(0, 8)).toString("hex") !== BIN_ARRAY_DISCRIMINATOR) {
    throw new Error("Not a Meteora DLMM bin array account");
  }
  const v = view(binArrayData);
  const index = Number(v.getBigInt64(8, true));
  if (meteoraBinArrayIndex(binId) !== index) throw new Error("Bin is not in this Meteora bin array");
  const offset = BIN_ARRAY_HEADER_LEN + (binId - index * METEORA_BINS_PER_ARRAY) * BIN_LEN;
  return {
    amountX: v.getBigUint64(offset, true),
    amountY: v.getBigUint64(offset + 8, true),
    liquiditySupply: u128(v, offset + 32),
    feeXPerTokenStored: u128(v, offset + 80),
    feeYPerTokenStored: u128(v, offset + 96),
  };
}

export type MeteoraPositionTotals = { amountX: bigint; amountY: bigint; feeX: bigint; feeY: bigint };

/**
 * Token amounts (floor of share × reserve / supply per bin) and uncollected fees
 * (pending + (share >> 64) × Δfee-per-token >> 64 per bin), as `DLMM.processPosition`.
 * `binFor` returns the bin's live state; it must cover every bin of the position.
 */
export function meteoraPositionTotals(position: MeteoraPosition, binFor: (binId: number) => MeteoraBinFeeGrowth): MeteoraPositionTotals {
  let amountX = 0n, amountY = 0n, feeX = 0n, feeY = 0n;
  for (const bin of position.bins) {
    const live = binFor(bin.binId);
    if (live.liquiditySupply > 0n) {
      amountX += bin.liquidityShare * live.amountX / live.liquiditySupply;
      amountY += bin.liquidityShare * live.amountY / live.liquiditySupply;
    }
    feeX += bin.feeXPending;
    feeY += bin.feeYPending;
    if (bin.liquidityShare > 0n) {
      const share = bin.liquidityShare >> SCALE_OFFSET;
      const dx = live.feeXPerTokenStored - bin.feeXPerTokenComplete;
      const dy = live.feeYPerTokenStored - bin.feeYPerTokenComplete;
      if (dx < 0n || dy < 0n) throw new Error("Meteora bin fee accumulator is behind the position");
      feeX += (share * dx) >> SCALE_OFFSET;
      feeY += (share * dy) >> SCALE_OFFSET;
    }
  }
  return { amountX, amountY, feeX, feeY };
}

/** Bin-array-backed lookup for `meteoraPositionTotals`. */
export function meteoraBinLookup(binArrays: ReadonlyMap<number, Uint8Array>): (binId: number) => MeteoraBinFeeGrowth {
  return (binId) => {
    const data = binArrays.get(meteoraBinArrayIndex(binId));
    if (!data) throw new Error("Meteora bin array missing for position bins");
    return readMeteoraBinFeeGrowth(data, binId);
  };
}

/** Where the active bin sits relative to the position's inclusive bin range. */
export function meteoraRangeSide(activeId: number, lowerBinId: number, upperBinId: number): "below" | "inside" | "above" {
  if (activeId < lowerBinId) return "below";
  if (activeId > upperBinId) return "above";
  return "inside";
}

/** Sum of the position's liquidity shares (u128 scaled by 2^64), for display. */
export function meteoraPositionLiquidity(position: MeteoraPosition): bigint {
  return position.bins.reduce((sum, bin) => sum + bin.liquidityShare, 0n);
}

export type { MeteoraBinArray };
