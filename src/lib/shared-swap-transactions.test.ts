import { describe, expect, it, vi } from "vitest";
import { ComputeBudgetProgram, PublicKey, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { swapRouteInstructions } from "@sofinance/engine/swap";
import { netSwapInput, swapFeeTransferInstructions } from "@sofinance/engine/swap";
vi.mock("server-only", () => ({}));
const key = (value: number) => new PublicKey(new Uint8Array(32).fill(value));
const wallet = key(1), recipient = key(2), mint = key(3), source = key(4);
const route = {
  setupInstructions: [{ programId: key(5).toBase58(), accounts: [], data: "AQ==" }],
  swapInstruction: { programId: key(6).toBase58(), accounts: [{ pubkey: wallet.toBase58(), isSigner: true, isWritable: true }], data: "Ag==" },
  cleanupInstruction: { programId: key(7).toBase58(), accounts: [], data: "Aw==" },
  otherInstructions: [{ programId: key(8).toBase58(), accounts: [], data: "BA==" }],
};
// Captured against the pre-refactor implementation. Fixed payer, blockhash,
// accounts and opaque upstream instructions make wire snapshots reproducible.
describe("pre-refactor swap transaction wire snapshots", () => {
  it.each(["open-native", "open-token", "open-token2022", "compound", "selected", "floored-zero"])("%s", (flow) => {
    const { feeAmount } = netSwapInput(flow === "floored-zero" ? 999n : 1_000_000n, 10);
    // Native SOL pays its fee inside the Jupiter swap (input-mint platform
    // fee), so the open-native wire carries no separate fee instruction.
    const fees = flow === "open-native" ? [] : swapFeeTransferInstructions(
      { payer: wallet, owner: wallet, recipient, amount: feeAmount, kind: "token", mint, source, decimals: 6,
        program: flow === "open-token2022" ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID });
    const swaps = swapRouteInstructions([route], wallet);
    const transaction = new VersionedTransaction(new TransactionMessage({ payerKey: wallet, recentBlockhash: key(9).toBase58(),
      instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), ...fees, ...swaps],
    }).compileToV0Message());
    expect(Buffer.from(transaction.serialize()).toString("base64")).toMatchSnapshot();
  });
});
