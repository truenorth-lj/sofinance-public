import { createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { describe, expect, it, vi } from "vitest";
import { DirectFeeWalletInstructionError, type SwapFeeConfig } from "@sofinance/engine/swap/fee";

vi.mock("server-only", () => ({}));

const { assertMeteoraFeeRule, MeteoraSystemTransferError } = await import("./meteora-open");

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const WALLET = Keypair.generate().publicKey;
const FEE_WALLET = Keypair.generate().publicKey;
const feeConfig = (): SwapFeeConfig => ({ wallet: FEE_WALLET, bps: 10 });

describe("Meteora fee rule", () => {
  it("guard rejects direct fee-wallet transfers, fee-wallet ATA creation and bare SystemProgram transfers", () => {
    const config = feeConfig();
    expect(() => assertMeteoraFeeRule([SystemProgram.transfer({ fromPubkey: WALLET, toPubkey: FEE_WALLET, lamports: 1 })], config)).toThrow(DirectFeeWalletInstructionError);
    const feeAta = getAssociatedTokenAddressSync(new PublicKey(USDC), FEE_WALLET);
    expect(() => assertMeteoraFeeRule([createAssociatedTokenAccountIdempotentInstruction(WALLET, feeAta, FEE_WALLET, new PublicKey(USDC))], config)).toThrow(DirectFeeWalletInstructionError);
    expect(() => assertMeteoraFeeRule([SystemProgram.transfer({ fromPubkey: WALLET, toPubkey: Keypair.generate().publicKey, lamports: 1 })], config)).toThrow(MeteoraSystemTransferError);
  });
});
