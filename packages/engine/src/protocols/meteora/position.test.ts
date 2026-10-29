import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import fixture from "../../fixtures/meteora-positions-cbbtc-wbtc.json";
import { decodeLbPair, meteoraBinArrayAddress, meteoraBinArrayIndex } from "./accounts";
import { METEORA_ALLOWLISTED_POOLS, METEORA_DLMM_PROGRAM_ID } from "./constants";
import {
  METEORA_POSITION_BASE_LEN, METEORA_POSITION_V2_DISCRIMINATOR, decodeMeteoraPosition, isMeteoraPositionAccount,
  meteoraBinLookup, meteoraPositionTotals, meteoraRangeSide, readMeteoraBinFeeGrowth,
} from "./position";

const accounts = fixture.accounts as Record<string, { owner: string; data: string } | null>;
const bytes = (address: string) => Buffer.from(accounts[address]!.data, "base64");
const POOL = fixture.pool;
const pool = decodeLbPair(bytes(POOL));
const arrays = new Map([-1, 0, 1].map((index) => [index, bytes(meteoraBinArrayAddress(POOL, index))] as const));
const expected = fixture.expected as Record<string, { owner: string; lowerBinId: number; upperBinId: number; totalXAmount: string; totalYAmount: string; feeX: string; feeY: string; totalClaimedFeeX: string; totalClaimedFeeY: string }>;

describe("Meteora DLMM PositionV2 (mainnet cbBTC/WBTC capture)", () => {
  it("discriminator is sha256(account:PositionV2)[0..8]", () => {
    expect(createHash("sha256").update("account:PositionV2").digest("hex").slice(0, 16)).toBe(METEORA_POSITION_V2_DISCRIMINATOR);
  });

  it("decodes pool, owner, range and claimed fees of each captured position", () => {
    expect(POOL).toBe(METEORA_ALLOWLISTED_POOLS[0]!.poolAddress);
    expect(pool.activeId).toBe(16);
    for (const address of fixture.positions) {
      expect(accounts[address]!.owner).toBe(METEORA_DLMM_PROGRAM_ID);
      const data = bytes(address);
      expect(data.length).toBe(METEORA_POSITION_BASE_LEN);
      const position = decodeMeteoraPosition(data);
      const want = expected[address]!;
      expect(position).toMatchObject({ lbPair: POOL, owner: want.owner, lowerBinId: want.lowerBinId, upperBinId: want.upperBinId,
        totalClaimedFeeX: BigInt(want.totalClaimedFeeX), totalClaimedFeeY: BigInt(want.totalClaimedFeeY) });
      expect(position.bins).toHaveLength(want.upperBinId - want.lowerBinId + 1);
    }
    expect(fixture.positions.map((address) => {
      const position = decodeMeteoraPosition(bytes(address));
      return meteoraRangeSide(pool.activeId, position.lowerBinId, position.upperBinId);
    })).toEqual(["inside", "inside", "above", "below", "inside"]);
  });

  it("amounts and uncollected fees match @meteora-ag/dlmm processPosition exactly", () => {
    for (const address of fixture.positions) {
      const totals = meteoraPositionTotals(decodeMeteoraPosition(bytes(address)), meteoraBinLookup(arrays));
      const want = expected[address]!;
      expect({ x: totals.amountX.toString(), y: totals.amountY.toString(), fx: totals.feeX.toString(), fy: totals.feeY.toString() }, address)
        .toEqual({ x: want.totalXAmount, y: want.totalYAmount, fx: want.feeX, fy: want.feeY });
    }
  });

  it("reads extended positions (bins appended after the base account)", () => {
    const base = bytes(fixture.positions[0]!);
    const width = 72; // 2 extended bins
    const data = Buffer.concat([base, Buffer.alloc(2 * 112)]);
    data.writeInt32LE(-15, 7912);
    data.writeInt32LE(-15 + width - 1, 7916);
    const ext = METEORA_POSITION_BASE_LEN + 112; // second extended bin
    data.writeBigUInt64LE(5n, ext); // share low word
    data.writeBigUInt64LE(7n, ext + 64 + 32); // fee_x_pending
    const position = decodeMeteoraPosition(data);
    expect(position.bins).toHaveLength(width);
    expect(position.bins[71]).toMatchObject({ binId: 56, liquidityShare: 5n, feeXPending: 7n, feeYPending: 0n });
    expect(() => decodeMeteoraPosition(data.subarray(0, METEORA_POSITION_BASE_LEN + 112))).toThrow("truncated");
  });

  it("rejects non-position accounts and missing bin arrays", () => {
    expect(isMeteoraPositionAccount(bytes(POOL))).toBe(false);
    expect(() => decodeMeteoraPosition(bytes(POOL))).toThrow("Not a Meteora DLMM position account");
    expect(() => readMeteoraBinFeeGrowth(arrays.get(0)!, -1)).toThrow("not in this");
    expect(() => readMeteoraBinFeeGrowth(bytes(POOL), 0)).toThrow("Not a Meteora DLMM bin array");
    const position = decodeMeteoraPosition(bytes(fixture.positions[0]!));
    expect(() => meteoraPositionTotals(position, meteoraBinLookup(new Map([[0, arrays.get(0)!]])))).toThrow("bin array missing");
    expect(meteoraBinArrayIndex(position.lowerBinId)).toBe(-1);
  });
});
