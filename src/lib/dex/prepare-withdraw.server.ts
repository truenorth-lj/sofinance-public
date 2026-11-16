import "@/lib/engine-host";
import "server-only";
import type { WithdrawPrepareRequest } from "@sofinance/engine/withdraw/types";
import { rpcConnection } from "@sofinance/engine/rpc";
import { withTransientRetry } from "@/lib/withdraw/retry";
import { refreshWithdrawBlockhash } from "@/lib/withdraw/fresh-prepare";
import { txPermitsFor } from "@/lib/tx-send/permit";
import { dexRegistry } from "./registry-instance";
import { MCP_WITHDRAW_PREPARE, type WithdrawPrepareProfile, type WithdrawalPreparation } from "./withdraw-prepare";

export async function prepareWithdrawal(id: string, input: WithdrawPrepareRequest,
  profile: WithdrawPrepareProfile): Promise<WithdrawalPreparation> {
  // HTTP still passes raw JSON: preserve engine validation, and snapshot the full
  // signed previous stage before lazy loading or an app retry can yield.
  const command = structuredClone(input);
  if (profile === MCP_WITHDRAW_PREPARE) return dexRegistry.buildWithdrawal(id, command);
  const prepared = await withTransientRetry(() => dexRegistry.buildWithdrawal(id, command));
  const fresh = await refreshWithdrawBlockhash(rpcConnection(), prepared);
  return { ...fresh, ...txPermitsFor(command.wallet, fresh.unsignedTransaction, fresh.summary.lastValidBlockHeight) };
}

/** Preview keeps engine confirmation bypass and returns only a summary, never an executable authorization. */
export async function quoteWithdrawal(id: string, input: WithdrawPrepareRequest) {
  const command = structuredClone(input);
  return (await withTransientRetry(() => dexRegistry.buildWithdrawal(id, command, true))).summary;
}
