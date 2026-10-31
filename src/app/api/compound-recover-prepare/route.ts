import "@/lib/engine-host";
import { parseWallet } from "@sofinance/engine/api-input";
import { readCompoundBody } from "@/lib/compound-api";
import { buildAndSimulateCompoundRecovery } from "@sofinance/engine/compound-recovery";
import { issueCompoundPermit } from "@/lib/compound-permit";
import { apiError } from "@/lib/api-response";
import { getSigningSecret } from "@sofinance/engine/config/server-env";
import { PublicKey } from "@solana/web3.js";
import { rpcConnection } from "@sofinance/engine/rpc";
import { txPermitsFor } from "@/lib/tx-send/permit";

async function sourcesAlreadyClosed(wallet: string, descriptors: unknown, error: unknown) {
  // The builder has already checked each wallet-derived source descriptor.
  // Only its explicit no-sources result can take this path; RPC/validation
  // errors must never be treated as a completed cleanup.
  if (!(error instanceof Error) || error.message !== "No recoverable yield accounts; please verify original compound transaction status first" ||
    !Array.isArray(descriptors) || descriptors.length < 1 || descriptors.length > 2) return null;
  const accounts = descriptors.map((account: { address: string }) => account.address);
  const finalized = await rpcConnection().getMultipleAccountsInfo(accounts.map(address => new PublicKey(address)), "finalized");
  if (finalized.length !== accounts.length || finalized.some(account => account !== null)) return null;
  return { alreadyClosed: true as const, wallet, accounts };
}

export async function POST(request: Request) {
  try {
    const body = await readCompoundBody(request);
    const wallet = parseWallet(body.wallet);
    const prepared = await buildAndSimulateCompoundRecovery(wallet, body.compoundAccounts).catch(async error => {
      const closed = await sourcesAlreadyClosed(wallet, body.compoundAccounts, error);
      if (closed) return closed;
      throw error;
    });
    if ("alreadyClosed" in prepared) return Response.json(prepared, { headers: { "Cache-Control": "no-store" } });
    const { summary, transaction } = prepared;
    const secret = getSigningSecret();
    const permit = issueCompoundPermit(secret, { wallet, summary,
      message: Buffer.from(transaction.message.serialize()).toString("base64") });
    return Response.json({ summary, permit, unsignedTransaction: Buffer.from(transaction.serialize()).toString("base64"),
      ...txPermitsFor(wallet, Buffer.from(transaction.serialize()).toString("base64"), summary.lastValidBlockHeight, secret) },
      { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return apiError(error, "Remaining yield recovery preparation failed"); }
}
