import "@/lib/engine-host";
import { MCP_WITHDRAW_PREPARE } from "@/lib/dex";
import { getSigningSecret } from "@sofinance/engine/config/server-env";
import { createSignToken } from "../../lib/pending-sign-token";
import { buildSignUrl } from "../../lib/public-urls";

export async function prepareWithdraw(input: import("@sofinance/engine/withdraw/types").WithdrawPrepareRequest) {
 const command=structuredClone(input);
 const {prepareWithdrawal}=await import("@/lib/dex");
 const prepared=await prepareWithdrawal("raydium-clmm", command, MCP_WITHDRAW_PREPARE);
 const submitArgs={wallet:command.wallet,permit:prepared.permit,summary:prepared.summary,confirmHighImpact:command.confirmHighImpact===true};
 const signToken=await createSignToken({kind:"withdraw",wallet:command.wallet,unsignedTransaction:prepared.unsignedTransaction,permit:prepared.permit,submitArgs,expiresAt:prepared.summary.expiresAt},getSigningSecret());
 return {...prepared,submitArgs,signToken,signUrl:buildSignUrl(signToken)};
}
export async function submitWithdrawTransaction(input: Parameters<typeof import("../../lib/withdraw/send").submitWithdraw>[0]) {
 const {submitWithdraw}=await import("../../lib/withdraw/send");
 return submitWithdraw(input);
}
