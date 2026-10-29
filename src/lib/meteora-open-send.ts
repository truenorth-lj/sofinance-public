import "@/lib/engine-host";
import "server-only";

import {
  AddressLookupTableAccount, ComputeBudgetProgram, PublicKey, TransactionMessage, VersionedTransaction, type Connection,
} from "@solana/web3.js";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { createPermit } from "@sofinance/engine/auth/permit";
import { getSigningSecret } from "@sofinance/engine/config/server-env";
import { readSwapFeeConfig, type SwapFeeConfig } from "@sofinance/engine/swap/fee";
import { exceedsTxSizeLimit, isZeroSignature } from "@sofinance/engine/transaction-limits";
import { LIGHTHOUSE_PROGRAM_ID } from "@sofinance/engine/wallet-returned-tx";
import { assertWalletReturnedTransaction } from "@/lib/wallet-returned-guard";
import { assertMeteoraFeeRule } from "./meteora-open";

/**
 * Meteora open flow, signing half (behind METEORA_DLMM_WALLET_SIGNING_ENABLED). Every prepared transaction carries
 * a permit over the exact message the server simulated. `send` accepts a wallet-signed transaction only when:
 * the permit matches, the wallet changed nothing but ComputeBudget / Lighthouse instructions, every required
 * signature is valid, the #219 fee-wallet guard and the no-bare-SystemProgram-transfer check pass on what the
 * wallet returned, and a sigVerify re-simulation succeeds within the SOL debit cap. The server broadcasts only
 * what the user's wallet signed; it never holds a key.
 */
const meteoraOpenPermit = createPermit("sofinance:meteora-open:v1");

export type MeteoraTxKind = "setup" | "deposit" | "close";

export type MeteoraTxSummary = {
  kind: MeteoraTxKind;
  wallet: string;
  poolId: string;
  position: string;
  blockhash: string;
  lastValidBlockHeight: number;
  expiresAt: number;
  /** Most SOL (lamports) the wallet may lose in this tx, incl. fees and a 0.001 SOL priority-fee allowance the wallet may add. */
  maxSolDebitLamports: string;
};

export const METEORA_PERMIT_TTL_MS = 90_000;
/** Allowance for a priority fee a wallet may add to the compute budget. */
export const METEORA_WALLET_FEE_ALLOWANCE_LAMPORTS = 1_000_000n;

export class MeteoraSendError extends Error {
  /** false: rejected before broadcast (safe to prepare again). */
  constructor(message: string, readonly sent: boolean) {
    super(message);
    this.name = "MeteoraSendError";
  }
}

export function issueMeteoraTxPermit(transactionBase64: string, summary: MeteoraTxSummary) {
  const message = Buffer.from(VersionedTransaction.deserialize(Buffer.from(transactionBase64, "base64")).message.serialize()).toString("base64");
  return meteoraOpenPermit.issue(getSigningSecret(), { wallet: summary.wallet, message, summary });
}

const EXCLUDED = new Set([ComputeBudgetProgram.programId.toBase58(), LIGHTHOUSE_PROGRAM_ID.toBase58()]);

async function decompile(connection: Pick<Connection, "getAddressLookupTable">, transaction: VersionedTransaction) {
  const tables: AddressLookupTableAccount[] = [];
  for (const lookup of transaction.message.addressTableLookups) {
    const table = (await connection.getAddressLookupTable(lookup.accountKey, { commitment: "confirmed" })).value;
    if (!table) throw new Error("Address lookup table not found");
    tables.push(table);
  }
  return TransactionMessage.decompile(transaction.message, { addressLookupTableAccounts: tables }).instructions;
}

type SendConnection = Pick<Connection, "getAddressLookupTable" | "getBlockHeight" | "simulateTransaction" | "sendRawTransaction" | "getBalance">;

/** Validates and broadcasts one wallet-signed Meteora transaction. Returns its signature. */
export async function sendMeteoraTransaction(
  input: { signedTransaction: string; unsignedTransaction: string; permit: string; summary: MeteoraTxSummary },
  deps: { connection: SendConnection; feeConfig?: () => SwapFeeConfig; now?: () => number },
): Promise<{ signature: string }> {
  const now = deps.now ?? Date.now;
  const { summary } = input;
  const { connection } = deps;
  let signed: VersionedTransaction;
  try {
    signed = VersionedTransaction.deserialize(Buffer.from(input.signedTransaction, "base64"));
    const prepared = VersionedTransaction.deserialize(Buffer.from(input.unsignedTransaction, "base64"));
    const message = Buffer.from(prepared.message.serialize()).toString("base64");
    if (!meteoraOpenPermit.verify(getSigningSecret(), { wallet: summary.wallet, message, summary }, input.permit)) {
      throw new Error("Transaction does not match the simulated Meteora transaction");
    }
    if (summary.expiresAt <= now() || summary.blockhash !== prepared.message.recentBlockhash) {
      throw new Error("The transaction expired before it was sent. Please prepare it again.");
    }
    assertWalletReturnedTransaction(prepared, signed, summary.wallet);
    if (exceedsTxSizeLimit(signed.serialize().length)) throw new Error("The wallet made the transaction too large to send");

    const instructions = await decompile(connection, signed);
    const preparedCore = (await decompile(connection, prepared)).filter((ix) => !EXCLUDED.has(ix.programId.toBase58()));
    const signedCore = instructions.filter((ix) => !EXCLUDED.has(ix.programId.toBase58()));
    if (signedCore.length !== preparedCore.length) throw new Error("The wallet added instructions that SoFinance did not prepare");
    assertMeteoraFeeRule(instructions, (deps.feeConfig ?? readSwapFeeConfig)());

    const signedMessage = signed.message.serialize();
    const signers = signed.message.staticAccountKeys.slice(0, signed.message.header.numRequiredSignatures);
    const requiredSigners = summary.kind === "setup" ? [summary.wallet, summary.position] : [summary.wallet];
    const signerSet = signers.map((k) => k.toBase58());
    if (signerSet[0] !== summary.wallet || signerSet.length !== requiredSigners.length || requiredSigners.some((k) => !signerSet.includes(k))) {
      throw new Error("Unexpected signers");
    }
    signers.forEach((key, i) => {
      const signature = signed.signatures[i];
      if (isZeroSignature(signature) || !nacl.sign.detached.verify(signedMessage, signature!, key.toBytes())) {
        throw new Error(i === 0 ? "Wallet signature is invalid" : "Position signature is invalid");
      }
    });

    const wallet = new PublicKey(summary.wallet);
    const [height, before] = await Promise.all([connection.getBlockHeight("confirmed"), connection.getBalance(wallet, "confirmed")]);
    if (height > summary.lastValidBlockHeight) throw new Error("The transaction expired before it was sent. Please prepare it again.");
    const sim = await connection.simulateTransaction(signed, { sigVerify: true, commitment: "confirmed", accounts: { encoding: "base64", addresses: [wallet.toBase58()] } });
    if (sim.value.err) throw new Error(`Simulation failed: ${JSON.stringify(sim.value.err)}`);
    const after = BigInt(sim.value.accounts?.[0]?.lamports ?? 0);
    if (BigInt(before) - after > BigInt(summary.maxSolDebitLamports)) throw new Error("This transaction would use more SOL than estimated. Please prepare it again.");
  } catch (error) {
    throw new MeteoraSendError(error instanceof Error ? error.message : String(error), false);
  }
  const expected = bs58.encode(signed.signatures[0]!);
  try {
    const signature = await connection.sendRawTransaction(signed.serialize(), { skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 3 });
    if (signature !== expected) throw new Error("RPC returned a different signature");
    return { signature };
  } catch (error) {
    // A lost response may still have landed: the client checks the expected signature's status.
    throw Object.assign(new MeteoraSendError(error instanceof Error ? error.message : String(error), true), { signature: expected });
  }
}

export type MeteoraTxStatus = { signature: string; status: "pending" | "confirmed" | "failed" | "expired"; error?: string };

/** Status of a submitted signature; `expired` once its blockhash is past and it never landed. */
export async function meteoraTransactionStatus(
  input: { signature: string; lastValidBlockHeight: number },
  connection: Pick<Connection, "getSignatureStatuses" | "getBlockHeight">,
): Promise<MeteoraTxStatus> {
  const { value } = await connection.getSignatureStatuses([input.signature], { searchTransactionHistory: true });
  const status = value[0];
  if (status?.err) return { signature: input.signature, status: "failed", error: JSON.stringify(status.err) };
  if (status && (status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized")) return { signature: input.signature, status: "confirmed" };
  if (!status && (await connection.getBlockHeight("confirmed")) > input.lastValidBlockHeight) return { signature: input.signature, status: "expired" };
  return { signature: input.signature, status: "pending" };
}
