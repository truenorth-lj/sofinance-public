import "server-only";
import type { Connection, VersionedTransaction } from "@solana/web3.js";
import { rpcConnection } from "@sofinance/engine/rpc";
import { plainSimulationCause } from "./cause";

/**
 * One simulation of the exact bytes the wallet is about to see, on PUBLIC mainnet RPC (never a paid provider; PM
 * 2026-11-02), signatures not verified (the wallet has not signed yet) and the real blockhash kept (an expired one
 * must fail here, not in the wallet). `unavailable` means we could not ask Solana (429, timeout), not that the
 * transaction is bad.
 */
export type PreWalletSimulation = { ok: true; unitsConsumed?: number } | { ok: false; cause: string } | { ok: null; unavailable: true };

export const PRE_WALLET_SIM_TIMEOUT_MS = 8_000;

/** Empty env on purpose: the pool then resolves to public mainnet only, whatever paid providers the server has. */
const publicConnection = () => rpcConnection({}, { env: {}, retry: null });

export async function simulateBeforeWallet(transaction: VersionedTransaction,
  connection: Pick<Connection, "simulateTransaction"> = publicConnection()): Promise<PreWalletSimulation> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      connection.simulateTransaction(transaction, { sigVerify: false, replaceRecentBlockhash: false, commitment: "confirmed" }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("simulation timed out")), PRE_WALLET_SIM_TIMEOUT_MS); }),
    ]);
    if (result.value.err) return { ok: false, cause: plainSimulationCause(result.value.err, result.value.logs) };
    return { ok: true, ...(result.value.unitsConsumed !== undefined ? { unitsConsumed: result.value.unitsConsumed } : {}) };
  } catch (error) {
    // web3.js throws for an RPC-level error; BlockhashNotFound can arrive this way too and is a real answer.
    const message = error instanceof Error ? error.message : String(error);
    if (/BlockhashNotFound|blockhash not found/i.test(message)) return { ok: false, cause: plainSimulationCause("BlockhashNotFound", null) };
    return { ok: null, unavailable: true };
  } finally {
    clearTimeout(timer);
  }
}
