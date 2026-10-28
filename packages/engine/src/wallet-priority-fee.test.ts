import { ComputeBudgetProgram, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { expect, it } from "vitest";
import {
  WALLET_PRIORITY_FEE_CEILING_LAMPORTS,
  computeBudgetPriorityLamports,
  walletPriorityFeeAllowance,
} from "./wallet-priority-fee";
import { BLOCKHASH, testKeypair } from "./test-support/send-fixtures";

const wallet = testKeypair(1).publicKey;

function tx(instructions: ConstructorParameters<typeof TransactionMessage>[0]["instructions"]) {
  return new VersionedTransaction(new TransactionMessage({
    payerKey: wallet,
    recentBlockhash: BLOCKHASH,
    instructions,
  }).compileToV0Message());
}

it("priority is 0 without a ComputeBudget price", () => {
  expect(computeBudgetPriorityLamports(tx([]))).toBe(0n);
  expect(computeBudgetPriorityLamports(tx([ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 })]))).toBe(0n);
});

it("computes ceil(units * microLamports / 1e6)", () => {
  expect(computeBudgetPriorityLamports(tx([
    ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 2_500_000 }),
  ]))).toBe(3_500_000n);
});

it("defaults to 200_000 units when only price is set", () => {
  expect(computeBudgetPriorityLamports(tx([
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1_000_000 }),
  ]))).toBe(200_000n);
});

it("allows extra under the 0.01 SOL ceiling and rejects above it", () => {
  const prepared = tx([ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 })]);
  const raised = tx([
    ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 2_500_000 }),
  ]);
  expect(walletPriorityFeeAllowance(prepared, raised)).toBe(3_500_000n);
  expect(walletPriorityFeeAllowance(undefined, raised)).toBe(0n);
  const over = tx([
    ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 8_000_000 }),
  ]);
  expect(computeBudgetPriorityLamports(over)).toBeGreaterThan(WALLET_PRIORITY_FEE_CEILING_LAMPORTS);
  expect(() => walletPriorityFeeAllowance(prepared, over)).toThrow("Wallet priority fee exceeds 0.01 SOL");
});
