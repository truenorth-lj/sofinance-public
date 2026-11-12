import type { AccountInfo, PublicKey } from "@solana/web3.js";
import { unpackAccount } from "@solana/spl-token";
import { simulatedInputSpendMatches } from "./amount";

/** Decode a token ATA from an RPC or simulation account, or 0 when the account is missing. */
export function decodeTokenAccount(
  info: AccountInfo<Buffer> | null, key: PublicKey, program: PublicKey, wallet: PublicKey, mint: PublicKey,
): bigint {
  if (!info) return 0n;
  if (!info.owner.equals(program)) throw new Error("Token ATA program mismatch");
  const account = unpackAccount(key, info, program);
  if (!account.owner.equals(wallet) || !account.mint.equals(mint)) throw new Error("Token ATA owner or mint mismatch");
  return account.amount;
}

/** A swap must not reduce the wallet's existing balance of a pool token that is not the input mint. */
export function assertOriginalPoolAssetsUnspent(input: {
  inputMint: string; mintA: string; mintB: string; afterA: bigint; afterB: bigint; amountA: bigint; amountB: bigint;
}): void {
  if (input.inputMint !== input.mintA && input.afterA < input.amountA) throw new Error("Simulation used original pool asset A");
  if (input.inputMint !== input.mintB && input.afterB < input.amountB) throw new Error("Simulation used original pool asset B");
}

/**
 * Token-input spend must stay within the requested amount (and match it for a
 * cross-asset input). Native SOL input is checked against `solDebit` instead.
 */
export function simulatedInputSpend(input: {
  inputBefore: bigint | null;
  inputAfter: bigint | null;
  requested: bigint;
  inputMint: string;
  mintA: string;
  mintB: string;
  solDebit: bigint;
}): bigint | null {
  if (input.inputBefore !== null && input.inputAfter !== null) {
    const spentInput = input.inputBefore - input.inputAfter;
    const directInput = input.inputMint === input.mintA || input.inputMint === input.mintB;
    if (spentInput <= 0n || spentInput > input.requested || (!directInput && !simulatedInputSpendMatches(spentInput, input.requested))) {
      throw new Error(`Simulated input asset expenditure does not match limit (spent ${spentInput} of ${input.requested}, direct=${directInput})`);
    }
    return spentInput;
  }
  if (input.solDebit < input.requested - 1n) {
    throw new Error("Simulated native SOL expenditure below selected input amount");
  }
  return null;
}

/** Extra pool-token units left in the wallet after the simulated add, counting a direct input as spent. */
export function simulationTokenDust(input: {
  afterA: bigint; afterB: bigint; amountA: bigint; amountB: bigint;
  inputKind: string; inputMint: string; mintA: string; mintB: string; requested: bigint;
}): { dustA: string; dustB: string } {
  return {
    dustA: (input.afterA - input.amountA + (input.inputKind === "token" && input.inputMint === input.mintA ? input.requested : 0n)).toString(),
    dustB: (input.afterB - input.amountB + (input.inputKind === "token" && input.inputMint === input.mintB ? input.requested : 0n)).toString(),
  };
}
