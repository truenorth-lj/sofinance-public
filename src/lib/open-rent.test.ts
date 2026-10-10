import { beforeEach, describe, expect, it, vi } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  getPdaProtocolPositionAddress, getPdaTickArrayAddress, PersonalPositionLayout,
  TickArrayLayout, TickArrayUtil,
} from "@raydium-io/raydium-sdk-v2";

vi.mock("server-only", () => ({}));

import { estimateOpenPositionRent } from "./open-rent";
import fixture from "./fixtures/open-rent-token22-mainnet.json";

const programId = Keypair.generate().publicKey;
const poolId = Keypair.generate().publicKey;
const tickLower = -60;
const tickUpper = 60;

function account(owner: PublicKey, bytes: number) {
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
  const getMinimumBalanceForRentExemption = vi.fn();
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
    getAccountInfo.mockResolvedValue(account(programId, 225));
    const rent = await estimateOpenPositionRent({
      connection: connection as never,
      programId: programId.toBase58(),
      poolId: poolId.toBase58(),
      tickLower,
      tickUpper,
      tickSpacing: 1,
    });
    expect(rent.protocolPositionInitRequired).toBe(false);
    expect(rent.protocolPositionLamports).toBe(0n);
    expect(rent.nonRefundableLamports).toBe(rent.tickArrayLamports);
  });

  it("does not treat a missing protocol PDA as init-required rent", async () => {
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
    expect(missing.protocolPositionInitRequired).toBe(false);
    expect(missing.protocolPositionLamports).toBe(0n);
    expect(missing.nonRefundableLamports).toBe(missing.tickArrayLamports);

    getAccountInfo.mockResolvedValue(account(PublicKey.default, 0));
    const empty = await estimateOpenPositionRent({
      connection: connection as never,
      programId: programId.toBase58(),
      poolId: poolId.toBase58(),
      tickLower,
      tickUpper,
      tickSpacing: 60,
    });
    expect(empty.protocolPositionInitRequired).toBe(false);
    expect(empty.protocolPositionLamports).toBe(0n);
  });

  it("quotes the live Token-2022 open rent from the mainnet transaction fixture", async () => {
    const program = new PublicKey(fixture.programId);
    const pool = new PublicKey(fixture.poolId);
    const derivedProtocol = getPdaProtocolPositionAddress(
      program, pool, fixture.tickLower, fixture.tickUpper,
    ).publicKey.toBase58();
    const startLower = TickArrayUtil.getTickArrayStartIndex(fixture.tickLower, fixture.tickSpacing);
    const startUpper = TickArrayUtil.getTickArrayStartIndex(fixture.tickUpper, fixture.tickSpacing);
    const derivedLower = getPdaTickArrayAddress(program, pool, startLower).publicKey.toBase58();
    const derivedUpper = getPdaTickArrayAddress(program, pool, startUpper).publicKey.toBase58();

    expect(derivedProtocol).toBe(fixture.accounts.protocolPosition.pubkey);
    expect(fixture.accounts.protocolPosition.exists).toBe(false);
    expect(fixture.accounts.protocolPosition.writable).toBe(false);
    expect(startLower).toBe(fixture.tickArrayStartLower);
    expect(startUpper).toBe(fixture.tickArrayStartUpper);
    expect(derivedLower).toBe(fixture.accounts.tickArrayLower.pubkey);
    expect(derivedUpper).toBe(fixture.accounts.tickArrayUpper.pubkey);
    expect(PersonalPositionLayout.span).toBe(fixture.accounts.personalPosition.space);
    expect(TickArrayLayout.span).toBe(fixture.accounts.tickArrayLower.space);

    const owned = {
      [fixture.accounts.tickArrayLower.pubkey]: account(program, fixture.accounts.tickArrayLower.space),
      [fixture.accounts.tickArrayUpper.pubkey]: account(program, fixture.accounts.tickArrayUpper.space),
    };
    getMultipleAccountsInfo.mockImplementation(async (keys: PublicKey[]) =>
      keys.map((key) => owned[key.toBase58()] ?? null));
    getAccountInfo.mockResolvedValue(null);
    getMinimumBalanceForRentExemption.mockImplementation(async (space: number) => {
      const rent = fixture.rentExemptionLamports[String(space) as keyof typeof fixture.rentExemptionLamports];
      if (rent === undefined) throw new Error(`unexpected rent space ${space}`);
      return rent;
    });

    const rent = await estimateOpenPositionRent({
      connection: connection as never,
      programId: fixture.programId,
      poolId: fixture.poolId,
      tickLower: fixture.tickLower,
      tickUpper: fixture.tickUpper,
      tickSpacing: fixture.tickSpacing,
    });

    const refundable = BigInt(fixture.accounts.nftMint.postLamports)
      + BigInt(fixture.accounts.nftAta.postLamports)
      + BigInt(fixture.accounts.personalPosition.postLamports);
    expect(rent.positionNftLamports).toBe(BigInt(fixture.accounts.nftMint.postLamports));
    expect(rent.nftAtaLamports).toBe(BigInt(fixture.accounts.nftAta.postLamports));
    expect(rent.personalPositionLamports).toBe(BigInt(fixture.accounts.personalPosition.postLamports));
    expect(rent.refundableLamports).toBe(refundable);
    expect(rent.tickArrayInitRequired).toBe(false);
    expect(rent.tickArrayLamports).toBe(0n);
    expect(rent.protocolPositionInitRequired).toBe(false);
    expect(rent.protocolPositionLamports).toBe(0n);
    expect(rent.nonRefundableLamports).toBe(0n);
    expect(getMinimumBalanceForRentExemption).toHaveBeenCalledWith(fixture.accounts.nftMint.space, "confirmed");
    expect(rent.refundableLamports + BigInt(fixture.beamTipLamports) + BigInt(fixture.feeLamports))
      .toBe(BigInt(-fixture.walletDeltaLamports));
  });
});
