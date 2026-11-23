import "@/lib/engine-host";
import { rpcConnection } from "@sofinance/engine/rpc";
import { readSignatureFinality, type FinalityStatus } from "@/lib/transaction-finality";
import type { TxStatusInput } from "../schemas";

const MEANING: Readonly<Record<FinalityStatus, string>> = Object.freeze({
  finalized: "Landed and finalized. It cannot be rolled back.",
  confirmed: "Landed and confirmed by the cluster (finalization usually follows within about 15 seconds).",
  failed: "Landed but the transaction failed on-chain. Nothing it tried to do took effect, apart from the network fee.",
  pending: "Not settled at the requested commitment yet. Ask again in a few seconds.",
  expired: "Solana never saw this signature and its blockhash has expired, so it can no longer land. It is safe to prepare again.",
  unknown: "Solana has no record of this signature yet. Pass lastValidBlockHeight from the prepare result to tell pending from expired.",
});

/**
 * Finality of a Solana signature, for agents whose wallet broadcasts the transaction itself (e.g. Phantom MCP
 * `solana_send`). Same logic as `POST /api/transaction-finality`; one status RPC call per request.
 */
export async function txStatus(input: TxStatusInput) {
  const { status, slot } = await readSignatureFinality(rpcConnection(), input);
  return {
    signature: input.signature,
    chain: "solana:mainnet" as const,
    commitment: input.commitment,
    status,
    settled: status === "finalized" || status === "confirmed" || status === "failed" || status === "expired",
    slot,
    meaning: MEANING[status],
    explorerUrl: `https://solscan.io/tx/${input.signature}`,
  };
}
