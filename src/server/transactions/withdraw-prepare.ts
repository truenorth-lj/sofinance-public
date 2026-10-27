import "@/lib/engine-host";
import "server-only";
import { buildWithdraw } from "@sofinance/engine/withdraw/build";
import type { WithdrawPrepareRequest, WithdrawPrepared } from "@sofinance/engine/withdraw/types";
import { rpcConnection } from "@sofinance/engine/rpc";
import { withTransientRetry } from "@/lib/withdraw/retry";
import { refreshWithdrawBlockhash } from "@/lib/withdraw/fresh-prepare";
import { APP_WITHDRAW_PREPARE, MCP_WITHDRAW_PREPARE } from "./surface-policy";

// HTTP passes raw JSON; this annotation is not validation. buildWithdraw retains
// its original parser and previous/receipt checks. MCP has already parsed input.
export async function prepareWithdrawal(input: WithdrawPrepareRequest,
  profile: typeof APP_WITHDRAW_PREPARE | typeof MCP_WITHDRAW_PREPARE): Promise<WithdrawPrepared> {
  if (profile === MCP_WITHDRAW_PREPARE) return buildWithdraw(input);
  const prepared = await withTransientRetry(() => buildWithdraw(input));
  return refreshWithdrawBlockhash(rpcConnection(), prepared);
}
