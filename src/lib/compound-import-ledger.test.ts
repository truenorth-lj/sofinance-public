import { afterEach, describe, expect, it, vi } from "vitest";
import { getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { PublicKey, type PartiallyDecodedInstruction } from "@solana/web3.js";
import { compoundHistoryFixture } from "./test-support/compound-history-fixture";
import { verifyImportedYieldLedger } from "@sofinance/engine/compound-import-ledger";

afterEach(() => vi.unstubAllEnvs());

function fixture() {
  const { transaction, wallet, attempt } = compoundHistoryFixture();
  const summary = attempt.summary;
  const feeAta = getAssociatedTokenAddressSync(new PublicKey(summary.state.mintA), new PublicKey(summary.feeWallet!), true, TOKEN_2022_PROGRAM_ID);
  const payment = transaction.transaction.message.instructions[7]!;
  if (!("parsed" in payment)) throw new Error("Missing fee fixture");
  payment.parsed.info.destination = feeAta.toBase58();
  transaction.transaction.message.accountKeys[6]!.pubkey = feeAta;
  vi.stubEnv("SOFINANCE_FEE_WALLET", summary.feeWallet!);
  // The historical 10-bps fee remains valid after the operator changes bps.
  vi.stubEnv("SOFINANCE_FEE_BPS", "20");
  const receipt = { wallet, positionMint: attempt.positionMint, sourceSignature: attempt.signature, compoundAccounts: summary.compoundAccounts };
  return { payment, transaction, verify: () => verifyImportedYieldLedger(transaction, receipt,
    transaction.transaction.message.instructions.flatMap((instruction, index) =>
      "accounts" in instruction ? [{ instruction: instruction as PartiallyDecodedInstruction, index }] : []), {}) };
}

describe("historical compound protocol fees", () => {
  it("recognizes the captured harvest/fee/swap/add ledger without treating its fee as existing principal", async () => {
    await expect(fixture().verify()).resolves.toBeUndefined();
  });
  it.each(["recipient", "authority", "mint", "program", "decimals", "amount", "output-source", "unchecked"])("rejects an unproven fee %s", async field => {
    const { payment, verify } = fixture();
    const info = payment.parsed.info;
    if (field === "recipient") info.destination = PublicKey.default.toBase58();
    if (field === "authority") info.authority = PublicKey.default.toBase58();
    if (field === "mint") info.mint = PublicKey.default.toBase58();
    if (field === "program") payment.programId = TOKEN_PROGRAM_ID;
    if (field === "decimals") info.tokenAmount.decimals = 6;
    if (field === "amount") info.tokenAmount.amount = "1000";
    if (field === "output-source") {
      const { attempt } = compoundHistoryFixture();
      info.source = attempt.summary.compoundAccounts[1].address;
      info.mint = attempt.summary.state.mintB;
    }
    if (field === "unchecked") payment.parsed.type = "transfer";
    await expect(verify()).rejects.toThrow(/unprovable|mismatch/i);
  });
  it("rejects duplicate top-level fee debits even when the final balance is adjusted to match", async () => {
    const { payment, transaction, verify } = fixture();
    transaction.transaction.message.instructions.splice(7, 0, payment);
    // Preserve protocol parent indexes after inserting the duplicate.
    for (const group of transaction.meta!.innerInstructions!) if (group.index >= 7) group.index++;
    transaction.meta!.postTokenBalances![1]!.uiTokenAmount.amount = "13007";
    await expect(verify()).rejects.toThrow(/unprovable/i);
  });
  it("rejects a fee when the operator has no configured recipient", async () => {
    const { verify } = fixture();
    vi.stubEnv("SOFINANCE_FEE_WALLET", "");
    await expect(verify()).rejects.toThrow(/unprovable/i);
  });
});
