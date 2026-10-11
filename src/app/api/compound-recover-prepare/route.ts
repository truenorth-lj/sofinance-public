import { parseWallet } from "@/lib/api-input";
import { readCompoundBody } from "@/lib/compound-api";
import { buildAndSimulateCompoundRecovery } from "@/lib/compound-recovery";
import { issueCompoundPermit } from "@/lib/compound-permit";
import { apiError } from "@/lib/api-response";
import { getSigningSecret } from "@/lib/config/server-env";

export async function POST(request: Request) {
  try {
    const body = await readCompoundBody(request);
    const wallet = parseWallet(body.wallet);
    const { summary, transaction } = await buildAndSimulateCompoundRecovery(wallet, body.compoundAccounts);
    const permit = issueCompoundPermit(getSigningSecret(), { wallet, summary,
      message: Buffer.from(transaction.message.serialize()).toString("base64") });
    return Response.json({ summary, permit, unsignedTransaction: Buffer.from(transaction.serialize()).toString("base64") },
      { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return apiError(error, "Remaining yield recovery preparation failed"); }
}
