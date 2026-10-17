import "@/lib/engine-host";
import { parseWallet } from "@sofinance/engine/api-input";
import { getSigningSecret } from "@sofinance/engine/config/server-env";
import { rpcConnection } from "@sofinance/engine/rpc";
import { readCompoundBody } from "@/lib/compound-api";
import { buildCleanupBatch, issueCleanupBatchPermit } from "@/lib/compound-cleanup-batch";
import { apiError } from "@/lib/api-response";
import type { CleanupBatchPrepared } from "@/lib/compound-cleanup-batch-types";

export const maxDuration = 120;

export async function POST(request: Request) {
  try {
    const body = await readCompoundBody(request), wallet = parseWallet(body.wallet);
    const prepared = await buildCleanupBatch(rpcConnection(), wallet, body.compoundAccounts);
    const response: CleanupBatchPrepared = { wallet, alreadyClosed: prepared.alreadyClosed,
      transactions: prepared.transactions.map(({ summary, transaction }) => ({ summary,
        permit: issueCleanupBatchPermit(getSigningSecret(), { wallet, summary, message: Buffer.from(transaction.message.serialize()).toString("base64") }),
        unsignedTransaction: Buffer.from(transaction.serialize()).toString("base64"),
      })) };
    return Response.json(response, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return apiError(error, "Batch cleanup preparation failed"); }
}
