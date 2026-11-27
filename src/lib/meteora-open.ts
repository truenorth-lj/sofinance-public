import "@/lib/engine-host";
import "server-only";

import { getAssociatedTokenAddressSync, NATIVE_MINT, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { SystemProgram, type PublicKey, type TransactionInstruction } from "@solana/web3.js";
import { assertNoDirectFeeWalletInstructions, type SwapFeeConfig } from "@sofinance/engine/swap/fee";

export class MeteoraSystemTransferError extends Error {
  constructor() {
    super("Meteora transactions must not contain a bare SystemProgram transfer");
    this.name = "MeteoraSystemTransferError";
  }
}

/**
 * Guard every Meteora transaction: no direct fee-wallet instruction of any kind (#219: no transfer to it,
 * no fee-wallet ATA created) and no bare top-level SystemProgram transfer (Phantom flags those).
 */
export function assertMeteoraFeeRule(instructions: TransactionInstruction[], config: SwapFeeConfig) {
  assertNoDirectFeeWalletInstructions(instructions, config.wallet);
  for (const ix of instructions) {
    if (isSystemTransfer(ix)) throw new MeteoraSystemTransferError();
  }
}

const isSystemTransfer = (ix: TransactionInstruction) =>
  ix.programId.equals(SystemProgram.programId) && ix.data.length >= 4 && ix.data.readUInt32LE(0) === 2;

/**
 * Guard of the SOL-input wrap step, the one Meteora transaction that may hold a SystemProgram transfer: exactly one,
 * of exactly `lamports`, from the wallet into the wallet's own wSOL account (the create / transfer / sync_native wrap
 * Jupiter itself emits). Nothing may touch the fee wallet, as everywhere else.
 */
export function assertMeteoraWrapRule(instructions: TransactionInstruction[], owner: PublicKey, lamports: bigint, config: SwapFeeConfig) {
  assertNoDirectFeeWalletInstructions(instructions, config.wallet);
  const wrapped = getAssociatedTokenAddressSync(NATIVE_MINT, owner, false, TOKEN_PROGRAM_ID);
  const transfers = instructions.filter(isSystemTransfer);
  const [transfer] = transfers;
  if (transfers.length !== 1 || !transfer || transfer.data.length < 12 || transfer.keys.length !== 2
    || !transfer.keys[0]!.pubkey.equals(owner) || !transfer.keys[1]!.pubkey.equals(wrapped) || transfer.data.readBigUInt64LE(4) !== lamports) {
    throw new MeteoraSystemTransferError();
  }
}
