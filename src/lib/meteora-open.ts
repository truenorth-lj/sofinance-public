import "@/lib/engine-host";
import "server-only";

import { SystemProgram, type TransactionInstruction } from "@solana/web3.js";
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
    if (ix.programId.equals(SystemProgram.programId) && ix.data.length >= 4 && ix.data.readUInt32LE(0) === 2) throw new MeteoraSystemTransferError();
  }
}
