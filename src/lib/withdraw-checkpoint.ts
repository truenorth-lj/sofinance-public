import { VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { z } from "zod";
import type { WithdrawPrepared, WithdrawRequest } from "@sofinance/engine/withdraw/types";

// The existing unversioned on-disk contract. Never replace prepared/request with display projections.
export type WithdrawCheckpoint = {
 prepared: WithdrawPrepared;
 signature: string;
 request: WithdrawRequest;
 confirmHighImpact: boolean;
 root?: { prepared: WithdrawPrepared; signature: string };
};
export type WithdrawHistory =
 | { kind: "missing"; raw: null }
 | { kind: "valid"; raw: string; checkpoint: WithdrawCheckpoint }
 | { kind: "invalid"; raw: string }
 | { kind: "unavailable" };

export const WITHDRAW_HISTORY_ERROR = "Withdrawal history could not be verified in browser storage. Nothing further will be signed or sent. Keep this browser's data and reload to check the saved transaction.";
export class WithdrawHistoryError extends Error {
 constructor() { super(WITHDRAW_HISTORY_ERROR); }
}

function base58Bytes(value: string, length: number) {
 try { return bs58.decode(value).length === length; } catch { return false; }
}
const address = z.string().refine(v => base58Bytes(v, 32));
const signature = z.string().refine(v => base58Bytes(v, 64));
const amount = z.string().regex(/^\d+$/);
const integer = z.number().int().nonnegative();
const decimals = integer.max(255);
const receive = z.enum(["usdc", "token", "original"]);
const asset = z.object({ mint: address, account: address, program: address, decimals, starting: amount, amount,
 minimum: amount.optional(), source: address.optional() });
const summary = z.object({
 operation: z.literal("withdraw"), wallet: address, positionMint: address, positionAccount: address, poolId: address,
 feePayer: address.optional(), percentBps: integer, receive, outputMint: address.optional(),
 stage: z.enum(["atomic", "withdraw", "swap"]), transactions: z.union([z.literal(1), z.literal(2)]), closesPosition: z.boolean(),
 startingLiquidity: amount, removedLiquidity: amount, assets: z.array(asset),
 isolatedSources: z.array(z.object({ seed: z.string(), address, mint: address, program: address, space: integer, rentLamports: integer })).optional(),
 outputs: z.array(z.object({ mint: address, expected: amount, minimum: amount, decimals })),
 priceImpactBps: z.number().nonnegative(), warning: z.boolean(), requiresSecondConfirmation: z.boolean(), slippageBps: z.number().nonnegative(),
 protocolFee: z.object({ bps: z.number().nonnegative(), wallet: address.nullable(), legs: z.array(z.object({ mint: address, amount, collectedMint: address.optional(), collectedAmount: amount.optional() })) }),
 rentRefundLamports: amount, maxSolDebitLamports: amount, expiresAt: integer, lastValidBlockHeight: integer, blockhash: address, bytes: integer,
 beam: z.object({ enabled: z.boolean(), included: z.boolean(), tipLamports: integer, tipAddress: address.nullable(), skippedReason: z.enum(["disabled", "no-tip-address", "oversize"]).nullable() }),
 tx1Signature: signature.optional(),
});
const prepared = z.object({ summary, permit: z.string().min(1), unsignedTransaction: z.string().min(1).refine(value => {
 try {
  const bytes = atob(value);
  if (btoa(bytes) !== value) return false;
  const transaction = VersionedTransaction.deserialize(Uint8Array.from(bytes, c => c.charCodeAt(0)));
  return transaction.serialize().length === bytes.length;
 } catch { return false; }
}) });
const request = z.object({ wallet: address, positionMint: address, percent: z.number().min(1).max(100).optional(),
 targetUSDC: z.number().positive().optional(), receive: receive.optional(), outputMint: address.optional(), confirmHighImpact: z.boolean().optional(),
}).refine(v => (v.percent === undefined) !== (v.targetUSDC === undefined));
const checkpoint = z.object({ prepared, signature, request, confirmHighImpact: z.boolean(), root: z.object({ prepared, signature }).optional() });

// Shape and identity checks only: permits, signatures and finalized receipts remain server responsibilities.
// Validate with schemas, but return the original parsed object, including every optional/unknown field.
export function isWithdrawCheckpoint(value: unknown, wallet: string, positionMint: string): value is WithdrawCheckpoint {
 const parsed = checkpoint.safeParse(value);
 if (!parsed.success) return false;
 const v = parsed.data;
 const matches = (s: { wallet: string; positionMint: string }) => s.wallet === wallet && s.positionMint === positionMint;
 // A conversion cannot safely restore first-stage history without its original prepared object/signature.
 if (v.prepared.summary.stage === "swap" && !v.root) return false;
 return matches(v.request) && matches(v.prepared.summary) && (!v.root || (
  matches(v.root.prepared.summary) && v.root.prepared.summary.stage === "withdraw" && v.prepared.summary.stage === "swap" &&
  (v.prepared.summary.tx1Signature === undefined || v.prepared.summary.tx1Signature === v.root.signature)
 ));
}
export function withdrawCheckpointKey(wallet: string, positionMint: string) { return `sofinance:withdraw:${wallet}:${positionMint}`; }

// Resolve localStorage inside the try as even accessing the browser property can throw.
export function readWithdrawHistory(wallet: string, positionMint: string): WithdrawHistory {
 let raw: string | null;
 try { raw = localStorage.getItem(withdrawCheckpointKey(wallet, positionMint)); } catch { return { kind: "unavailable" }; }
 if (raw === null) return { kind: "missing", raw };
 try {
  const value: unknown = JSON.parse(raw);
  return isWithdrawCheckpoint(value, wallet, positionMint) ? { kind: "valid", raw, checkpoint: value } : { kind: "invalid", raw };
 } catch { return { kind: "invalid", raw }; }
}
export function assertWithdrawHistory(wallet: string, positionMint: string, expected: WithdrawHistory) {
 const current = readWithdrawHistory(wallet, positionMint);
 if ((expected.kind !== "missing" && expected.kind !== "valid") ||
     (current.kind !== "missing" && current.kind !== "valid") || current.raw !== expected.raw) throw new WithdrawHistoryError();
}

/** A read/check/write/read fence, not an atomic cross-tab compare-and-swap. Never roll back uncertain writes. */
export function writeWithdrawHistory(wallet: string, positionMint: string, expected: WithdrawHistory, value: WithdrawCheckpoint | null): WithdrawHistory {
 assertWithdrawHistory(wallet, positionMint, expected);
 if (value !== null && !isWithdrawCheckpoint(value, wallet, positionMint)) throw new WithdrawHistoryError();
 try {
  const key = withdrawCheckpointKey(wallet, positionMint);
  const raw = value === null ? null : JSON.stringify(value);
  if (raw === null) localStorage.removeItem(key); else localStorage.setItem(key, raw);
  if (localStorage.getItem(key) !== raw) throw new WithdrawHistoryError();
  return value === null ? { kind: "missing", raw: null } : { kind: "valid", raw: raw!, checkpoint: value };
 } catch { throw new WithdrawHistoryError(); }
}
