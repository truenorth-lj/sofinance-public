import { beforeEach, describe, expect, it, vi } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import { getPdaProtocolPositionAddress, ProtocolPositionLayout } from "@raydium-io/raydium-sdk-v2";

vi.mock("server-only", () => ({}));

import { estimateOpenPositionRent } from "./open-rent";

const programId = Keypair.generate().publicKey;
const poolId = Keypair.generate().publicKey;
const tickLower = -60;
const tickUpper = 60;
const protocolKey = getPdaProtocolPositionAddress(programId, poolId, tickLower, tickUpper).publicKey;

function account(owner: PublicKey, bytes = ProtocolPositionLayout.span) {
  return {
    owner,
    data: Buffer.alloc(bytes),
    lamports: 1_000_000,
    executable: false,
    rentEpoch: 0,
  };
}

describe("estimateOpenPositionRent", () => {
  const getMultipleAccountsInfo = vi.fn();
  const getAccountInfo = vi.fn();
  const getMinimumBalanceForRentExemption = vi.fn(async () => 1_000_000);
  const connection = {
    getMultipleAccountsInfo,
    getAccountInfo,
    getMinimumBalanceForRentExemption,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    getMinimumBalanceForRentExemption.mockResolvedValue(1_000_000);
  });

  it("does not charge protocol-position rent when that account already exists", async () => {
    getMultipleAccountsInfo.mockResolvedValue([null, null]);
    getAccountInfo.mockResolvedValue(account(programId));
    const rent = await estimateOpenPositionRent({
      connection: connection as never,
      programId: programId.toBase58(),
      poolId: poolId.toBase58(),
      tickLower,
      tickUpper,
      tickSpacing: 1,
    });
    expect(getAccountInfo).toHaveBeenCalledWith(protocolKey, "confirmed");
    expect(rent.protocolPositionInitRequired).toBe(false);
    expect(rent.protocolPositionLamports).toBe(0n);
    expect(rent.nonRefundableLamports).toBe(rent.tickArrayLamports);
  });

  it("charges protocol-position rent only when the PDA is missing or not owned by the program", async () => {
    getMultipleAccountsInfo.mockResolvedValue([null]);
    getAccountInfo.mockResolvedValue(null);
    const missing = await estimateOpenPositionRent({
      connection: connection as never,
      programId: programId.toBase58(),
      poolId: poolId.toBase58(),
      tickLower,
      tickUpper,
      tickSpacing: 60,
    });
    expect(missing.protocolPositionInitRequired).toBe(true);
    expect(missing.protocolPositionLamports).toBe(1_000_000n);

    getAccountInfo.mockResolvedValue(account(PublicKey.default, 0));
    const empty = await estimateOpenPositionRent({
      connection: connection as never,
      programId: programId.toBase58(),
      poolId: poolId.toBase58(),
      tickLower,
      tickUpper,
      tickSpacing: 60,
    });
    expect(empty.protocolPositionInitRequired).toBe(true);
  });
});
