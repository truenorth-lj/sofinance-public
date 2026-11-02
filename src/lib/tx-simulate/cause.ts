/**
 * Plain-English cause for a failed pre-wallet simulation (`/api/tx-simulate`). Client-safe: no RPC, no secrets.
 * Known shapes get a sentence a user can act on; anything else names the failing instruction and the program's own last
 * log line (public chain data), never raw JSON.
 */
export const SIM_EXPIRED_CAUSE = "The transaction's recent blockhash expired before your wallet was asked, so nothing was sent.";
export const SIM_SLIPPAGE_CAUSE = "The price moved more than your slippage allows since the quote, so nothing was sent.";
export const SIM_NO_SOL_CAUSE = "Your wallet does not have enough SOL for this transaction's fees and account rent, so nothing was sent.";
export const SIM_NO_TOKENS_CAUSE = "Your wallet does not have enough of the input token for this amount, so nothing was sent.";

export function plainSimulationCause(err: unknown, logs: readonly string[] | null | undefined): string {
  const errText = typeof err === "string" ? err : JSON.stringify(err ?? null);
  const logText = (logs ?? []).join("\n");
  const text = `${errText}\n${logText}`;
  if (/BlockhashNotFound|blockhash not found/i.test(text)) return SIM_EXPIRED_CAUSE;
  if (/slippage|0x1771\b|"Custom":6001\b|ExceededAmountSlippageTolerance|ExceededBinSlippageTolerance/i.test(text)) return SIM_SLIPPAGE_CAUSE;
  if (/InsufficientFundsForRent|InsufficientFundsForFee|insufficient lamports|AccountNotFound/i.test(text)) return SIM_NO_SOL_CAUSE;
  if (/insufficient funds|custom program error: 0x1\b/i.test(text)) return SIM_NO_TOKENS_CAUSE;
  const index = typeof err === "object" && err && "InstructionError" in err && Array.isArray((err as { InstructionError: unknown[] }).InstructionError)
    ? (err as { InstructionError: unknown[] }).InstructionError[0] : undefined;
  const programLine = [...(logs ?? [])].reverse().find((line) => /Error|failed/i.test(line) && !/consumed/.test(line));
  const detail = programLine?.replace(/^Program log:\s*/, "").replace(/[{}"[\]]/g, "").replace(/\s+/g, " ").trim().slice(0, 160);
  const where = typeof index === "number" ? `instruction ${index + 1}` : "the transaction";
  return `Solana's simulation of this transaction failed at ${where}${detail ? ` (${detail.replace(/[.\s]+$/, "")})` : ""}, so nothing was sent.`;
}
