import "@/lib/engine-host";
import "server-only";

import { PublicKey, type Connection, type VersionedTransactionResponse } from "@solana/web3.js";
import { METEORA_ALLOWLISTED_POOLS, METEORA_DLMM_PROGRAM_ID } from "@sofinance/engine/protocols/meteora/constants";
import { METEORA_IX_DISCRIMINATOR } from "@sofinance/engine/protocols/meteora/open";
import { decodeMeteoraPosition, meteoraPositionLiquidity } from "@sofinance/engine/protocols/meteora/position";
import { logPositionOpenBestEffort } from "./opens-log";
import { sanitizeAddress, sanitizeSourceRef, sanitizeTxSignature } from "./opens-log/sanitize";
import type { PositionOpenRow } from "./opens-log/types";
import { meteoraPositionFirstSignature } from "./meteora-positions";

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

export class MeteoraRecordError extends Error {}

type RecordConnection = Pick<Connection, "getTransaction" | "getAccountInfo" | "getSignaturesForAddress">;

type DecodedIx = { programId: string; data: Uint8Array; accounts: string[] };

function topLevelInstructions(tx: VersionedTransactionResponse): DecodedIx[] {
  const keys = tx.transaction.message.getAccountKeys({ accountKeysFromLookups: tx.meta?.loadedAddresses ?? undefined });
  return tx.transaction.message.compiledInstructions.map((ix) => ({
    programId: keys.get(ix.programIdIndex)!.toBase58(),
    data: ix.data,
    accounts: ix.accountKeyIndexes.map((i) => keys.get(i)!.toBase58()),
  }));
}

/** add_liquidity_by_strategy2 accounts: 0 position, 1 lb_pair, 9 sender (see meteoraAddLiquidityByStrategy2Instruction). */
const isIx = (ix: DecodedIx, name: keyof typeof METEORA_IX_DISCRIMINATOR) =>
  ix.programId === METEORA_DLMM_PROGRAM_ID && Buffer.from(ix.data.subarray(0, 8)).equals(Buffer.from(METEORA_IX_DISCRIMINATOR[name], "hex"));

function feePayer(tx: VersionedTransactionResponse) {
  return tx.transaction.message.staticAccountKeys[0]?.toBase58();
}

/** USDC the wallet spent in the deposit (raw on-chain balances; analytics stays raw). */
function usdcSpent(tx: VersionedTransactionResponse, wallet: string): number | null {
  type Balances = NonNullable<NonNullable<VersionedTransactionResponse["meta"]>["preTokenBalances"]>;
  const sum = (list: Balances | null | undefined) =>
    (list ?? []).filter((b) => b.mint === USDC_MINT && b.owner === wallet).reduce((s, b) => s + Number(b.uiTokenAmount.uiAmountString ?? 0), 0);
  const spent = sum(tx.meta?.preTokenBalances) - sum(tx.meta?.postTokenBalances);
  return spent > 0 ? Math.round(spent * 1e6) / 1e6 : null;
}

/**
 * Verifies a landed Meteora open (1/2 setup + 2/2 deposit) on chain and logs it once, keyed by the
 * setup signature (the position account's first successful signature, which the position list
 * checks). Never signs or sends; only reads confirmed transactions.
 */
export async function verifyMeteoraOpen(
  input: { wallet: string; setupSignature: string; depositSignature: string; sourceRef?: unknown },
  connection: RecordConnection,
): Promise<PositionOpenRow> {
  const wallet = sanitizeAddress(input.wallet);
  const setupSig = sanitizeTxSignature(input.setupSignature);
  const depositSig = sanitizeTxSignature(input.depositSignature);
  if (!wallet || !setupSig || !depositSig || setupSig === depositSig) throw new MeteoraRecordError("Invalid wallet or signatures");
  const opts = { commitment: "confirmed" as const, maxSupportedTransactionVersion: 0 };
  const [setup, deposit] = await Promise.all([connection.getTransaction(setupSig, opts), connection.getTransaction(depositSig, opts)]);
  if (!setup || !deposit) throw new MeteoraRecordError("Transaction not confirmed yet");
  if (setup.meta?.err || deposit.meta?.err) throw new MeteoraRecordError("Transaction failed on chain");
  if (feePayer(setup) !== wallet || feePayer(deposit) !== wallet) throw new MeteoraRecordError("Fee payer is not the wallet");

  const init = topLevelInstructions(setup).filter((ix) => isIx(ix, "initializePosition"));
  if (init.length !== 1) throw new MeteoraRecordError("Setup does not initialize exactly one Meteora position");
  const [, position, lbPair, owner] = init[0]!.accounts;
  const pool = METEORA_ALLOWLISTED_POOLS.find((p) => p.poolAddress === lbPair);
  if (!pool || owner !== wallet || !position) throw new MeteoraRecordError("Position is not the wallet's in an allowlisted pool");

  const adds = topLevelInstructions(deposit).filter((ix) => isIx(ix, "addLiquidityByStrategy2"));
  if (adds.length !== 1 || adds[0]!.accounts[0] !== position || adds[0]!.accounts[1] !== lbPair || adds[0]!.accounts[9] !== wallet) {
    throw new MeteoraRecordError("Deposit does not add liquidity to this position");
  }
  const info = await connection.getAccountInfo(new PublicKey(position), "confirmed");
  if (!info || info.owner.toBase58() !== METEORA_DLMM_PROGRAM_ID) throw new MeteoraRecordError("Position account not found");
  const decoded = decodeMeteoraPosition(info.data);
  if (decoded.owner !== wallet || decoded.lbPair !== lbPair || meteoraPositionLiquidity(decoded) <= 0n) throw new MeteoraRecordError("Position is empty or not the wallet's");
  const first = await meteoraPositionFirstSignature(connection, position);
  if (first !== setupSig) throw new MeteoraRecordError("Setup is not the position's first transaction");
  return {
    txSignature: setupSig, wallet, poolAddress: lbPair,
    symbolA: pool.wrappedSymbol, symbolB: pool.plainSymbol,
    notionalUsd: usdcSpent(deposit, wallet), sourceRef: sanitizeSourceRef(input.sourceRef),
  };
}

export async function recordMeteoraOpen(input: Parameters<typeof verifyMeteoraOpen>[0], connection: RecordConnection) {
  const row = await verifyMeteoraOpen(input, connection);
  logPositionOpenBestEffort(row);
  return { recorded: true as const, txSignature: row.txSignature, poolAddress: row.poolAddress };
}
