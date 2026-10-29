import { VersionedTransaction } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { USDC_MINT } from "@sofinance/engine/ids";
import { withdrawPermit } from "@sofinance/engine/withdraw/permit";
import type { WithdrawPrepared, WithdrawRequest, WithdrawSummary } from "@sofinance/engine/withdraw/types";
import { BLOCKHASH, SIGNING_SECRET, buildTransaction, messageBase64, signatureOf, testKeypair, toBase64 } from "./send-fixtures";

export const withdrawSigner = testKeypair(71);
export const withdrawWallet = withdrawSigner.publicKey.toBase58();
export const withdrawPosition = testKeypair(72).publicKey.toBase58();
export const withdrawKey = `sofinance:withdraw:${withdrawWallet}:${withdrawPosition}`;
export const withdrawRequest: WithdrawRequest = { wallet: withdrawWallet, positionMint: withdrawPosition, percent: 100, receive: "usdc" };

// Complete builder-shaped records, with real disposable message bytes and test-only HMAC permits.
// This is a storage/runner fixture, not a real withdrawal instruction or financial receipt.
export function withdrawPrepared(stage: WithdrawSummary["stage"] = "atomic", overrides: Partial<WithdrawSummary> = {}): WithdrawPrepared {
 const transaction = buildTransaction({ payer: withdrawSigner, signWith: [], blockhash: stage === "swap" ? testKeypair(73).publicKey.toBase58() : BLOCKHASH });
 const summary: WithdrawSummary = {
  operation: "withdraw", wallet: withdrawWallet, positionMint: withdrawPosition,
  positionAccount: testKeypair(74).publicKey.toBase58(), poolId: testKeypair(75).publicKey.toBase58(),
  percentBps: 10000, receive: "usdc", outputMint: USDC_MINT, stage, transactions: stage === "atomic" ? 1 : 2,
  closesPosition: true, startingLiquidity: "10000000000000000", removedLiquidity: "10000000000000000",
  assets: [{ mint: USDC_MINT, account: testKeypair(76).publicKey.toBase58(), program: TOKEN_PROGRAM_ID.toBase58(), decimals: 6, starting: "99999999999999", amount: "1000000", minimum: "990000" }],
  isolatedSources: [], outputs: [{ mint: USDC_MINT, expected: "1000000", minimum: "990000", decimals: 6 }],
  priceImpactBps: 100, warning: false, requiresSecondConfirmation: false, slippageBps: 50,
  protocolFee: { bps: 10, wallet: testKeypair(77).publicKey.toBase58(), legs: [{ mint: USDC_MINT, amount: "1000", collectedMint: USDC_MINT, collectedAmount: "1000" }] },
  rentRefundLamports: "6117840", maxSolDebitLamports: "5000", expiresAt: Date.now() + 60000,
  lastValidBlockHeight: 150, blockhash: transaction.message.recentBlockhash, bytes: transaction.serialize().length,
  ...overrides,
 };
 return { summary, unsignedTransaction: toBase64(transaction), permit: withdrawPermit.issue(SIGNING_SECRET, { wallet: summary.wallet, message: messageBase64(transaction), summary }) };
}
export function signedWithdraw(prepared: WithdrawPrepared) {
 const transaction = VersionedTransaction.deserialize(Buffer.from(prepared.unsignedTransaction, "base64"));
 transaction.sign([withdrawSigner]);
 return { transaction, signature: signatureOf(transaction) };
}
export function withdrawCheckpoint(stage: WithdrawSummary["stage"] = "atomic", request: WithdrawRequest = withdrawRequest) {
 const first = withdrawPrepared("withdraw");
 const root = { prepared: first, signature: signedWithdraw(first).signature };
 const prepared = withdrawPrepared(stage, stage === "swap" ? { tx1Signature: root.signature } : {});
 return { prepared, signature: signedWithdraw(prepared).signature, request: { ...request }, confirmHighImpact: false, ...(stage === "swap" ? { root } : {}) };
}
