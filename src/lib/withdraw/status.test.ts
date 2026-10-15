import {beforeEach,expect,it,vi} from "vitest";
vi.mock("server-only",()=>({}));
const mocks=vi.hoisted(()=>({status:vi.fn(),height:vi.fn(),receipt:vi.fn(),balances:vi.fn(),invalidate:vi.fn(),reset:vi.fn()}));
vi.mock("@sofinance/engine/rpc",()=>({resetRpcCache:mocks.reset,rpcConnection:()=>({getSignatureStatuses:mocks.status,getBlockHeight:mocks.height,getTransaction:mocks.receipt,getMultipleAccountsInfo:mocks.balances})}));
vi.mock("../position-history-cache",()=>({invalidatePositionHistoryCache:mocks.invalidate}));
import {withdrawStatus} from "./status";
import {withdrawPermit} from "@sofinance/engine/withdraw/permit";
import type {WithdrawPrepared,WithdrawSummary} from "@sofinance/engine/withdraw/types";
import {SIGNING_SECRET,buildTransaction,messageBase64,signatureOf,testKeypair,toBase64} from "../test-support/send-fixtures";
const payer=testKeypair(1),transaction=buildTransaction({payer});
function input(){
 const summary={wallet:payer.publicKey.toBase58(),operation:"withdraw",stage:"swap",positionMint:testKeypair(5).publicKey.toBase58(),positionAccount:testKeypair(2).publicKey.toBase58(),lastValidBlockHeight:150,assets:[]} as unknown as WithdrawSummary;
 const prepared:WithdrawPrepared={summary,unsignedTransaction:toBase64(transaction),permit:withdrawPermit.issue(SIGNING_SECRET,{wallet:summary.wallet,message:messageBase64(transaction),summary})};
 return {signature:signatureOf(transaction),prepared};
}
beforeEach(()=>{vi.resetAllMocks();vi.stubEnv("JUPITER_API_KEY",SIGNING_SECRET);mocks.status.mockResolvedValue({value:[null]});mocks.height.mockResolvedValue(100);mocks.receipt.mockResolvedValue(null);mocks.balances.mockResolvedValue([null]);});
it("keeps confirmed transactions pending until finalization",async()=>{
 mocks.status.mockResolvedValue({value:[{confirmationStatus:"confirmed",err:null}]});
 expect(await withdrawStatus(input())).toHaveProperty("status","pending");expect(mocks.receipt).not.toHaveBeenCalled();
 expect(mocks.invalidate).not.toHaveBeenCalled();expect(mocks.reset).not.toHaveBeenCalled();
});
it("accepts only the complete finalized prepared message",async()=>{
 mocks.status.mockResolvedValue({value:[{confirmationStatus:"finalized",err:null}]});
 mocks.receipt.mockResolvedValue({meta:{err:null},transaction:{message:transaction.message}});
 expect(await withdrawStatus(input())).toHaveProperty("status","success");
 expect(mocks.invalidate).toHaveBeenCalledWith(input().prepared.summary.positionMint);expect(mocks.reset).toHaveBeenCalledOnce();
 const changed=buildTransaction({payer,blockhash:testKeypair(3).publicKey.toBase58()});
 mocks.receipt.mockResolvedValue({meta:{err:null},transaction:{message:changed.message}});
 expect(await withdrawStatus(input())).toHaveProperty("status","manual-review");
 expect(mocks.invalidate).toHaveBeenCalledOnce();expect(mocks.reset).toHaveBeenCalledOnce();
});
it("recognizes a finalized receipt even when the signature index is missing",async()=>{
 mocks.height.mockResolvedValue(151);mocks.receipt.mockResolvedValue({meta:{err:null},transaction:{message:transaction.message}});
 expect(await withdrawStatus(input())).toHaveProperty("status","success");
 expect(mocks.invalidate).toHaveBeenCalledWith(input().prepared.summary.positionMint);expect(mocks.reset).toHaveBeenCalledOnce();
});
it("rejects unauthorized prepared data and failed transactions",async()=>{
 const body=input();body.prepared.summary.wallet=testKeypair(4).publicKey.toBase58();
 await expect(withdrawStatus(body)).rejects.toThrow("authorization");
 mocks.status.mockResolvedValue({value:[{err:"failed"}]});expect(await withdrawStatus(input())).toHaveProperty("status","failed");
 expect(mocks.invalidate).not.toHaveBeenCalled();expect(mocks.reset).not.toHaveBeenCalled();
});
