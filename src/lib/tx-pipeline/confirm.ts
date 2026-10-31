/**
 * Stage 3 (confirm): signature polling only. It never resends: the wallet (or our one-shot
 * relay) already broadcast, and Phantom keeps rebroadcasting until the blockhash expires.
 */
export type TxChainStatus = "confirmed" | "failed" | "expired" | "pending";

export const solscanTxUrl = (signature: string) => `https://solscan.io/tx/${signature}`;

export async function readSignatureStatus(input: { signature: string; lastValidBlockHeight: number; fetchImpl?: typeof fetch }): Promise<TxChainStatus> {
  const response = await (input.fetchImpl ?? fetch)("/api/transaction-finality", {
    method: "POST", headers: { "Content-Type": "application/json" }, cache: "no-store",
    body: JSON.stringify({ signature: input.signature, lastValidBlockHeight: input.lastValidBlockHeight, commitment: "confirmed" }),
  });
  if (!response.ok) return "pending";
  const { status } = await response.json() as { status?: string };
  if (status === "confirmed" || status === "finalized") return "confirmed";
  if (status === "failed" || status === "expired") return status;
  return "pending";
}

/** Poll until confirmed, failed or expired. A failed status read is not a transaction failure. */
export async function pollSignature(input: {
  signature: string; lastValidBlockHeight: number; fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>; intervalMs?: number; maxPolls?: number; isCancelled?: () => boolean;
}): Promise<TxChainStatus> {
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let poll = 0; poll < (input.maxPolls ?? 90); poll++) {
    let status: TxChainStatus = "pending";
    try { status = await readSignatureStatus(input); } catch { /* keep polling */ }
    if (status !== "pending") return status;
    if (input.isCancelled?.()) return "pending";
    await sleep(input.intervalMs ?? 2_000);
    if (input.isCancelled?.()) return "pending";
  }
  return "pending";
}
