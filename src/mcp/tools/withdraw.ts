import "@/lib/engine-host";
import { MCP_WITHDRAW_PREPARE } from "@/server/transactions/surface-policy";
import { getSigningSecret } from "@sofinance/engine/config/server-env";
import { createSignToken } from "../../lib/pending-sign-token";
import { buildSignUrl } from "../../lib/public-urls";

export async function prepareWithdraw(input: import("@sofinance/engine/withdraw/types").WithdrawPrepareRequest) {
 const {prepareWithdrawal}=await import("@/server/transactions/withdraw-prepare");
 const prepared=await prepareWithdrawal(input, MCP_WITHDRAW_PREPARE);
 const submitArgs={wallet:input.wallet,permit:prepared.permit,summary:prepared.summary,confirmHighImpact:input.confirmHighImpact===true};
 const signToken=await createSignToken({kind:"withdraw",wallet:input.wallet,unsignedTransaction:prepared.unsignedTransaction,permit:prepared.permit,submitArgs,expiresAt:prepared.summary.expiresAt},getSigningSecret());
 return {...prepared,submitArgs,signToken,signUrl:buildSignUrl(signToken)};
}
export async function submitWithdrawTransaction(input: Parameters<typeof import("../../lib/withdraw/send").submitWithdraw>[0]) {
 const {submitWithdraw}=await import("../../lib/withdraw/send");
 return submitWithdraw(input);
}
