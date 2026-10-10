import "server-only";
import { liveReferenceMarks } from "./lp-live-marks";
import { analyzePositionLedger,classifyPositionJournal,commonCostBounds,historicalPositionMarks,historySnapshotMatches,type PriceRange } from "./lp-ledger-analysis";
import { readCurrentEquity } from "./lp-current-equity";
import { join } from "node:path";
import { readCapturedHistoricalMarks } from "./lp-historical-marks";
import { TOKEN_PROGRAM_ID,TOKEN_2022_PROGRAM_ID,unpackAccount } from "@solana/spl-token";
import { observedNftRentRefund } from "./lp-network-cost";
import { readdir,readFile } from "node:fs/promises";
import { CLMM_PROGRAM_ID, getPdaPersonalPositionAddress, PersonalPositionLayout, PoolInfoLayout } from "@raydium-io/raydium-sdk-v2";
import { PublicKey } from "@solana/web3.js";
import { createHash } from "node:crypto";
import { auditPositionFlows, type FlowContext } from "./lp-flow-audit";
import type { PublicTransaction } from "./lp-position-observations";
import { rpcRequest } from "./rpc";
const livePages=new Map<string,{at:number;transactions:Map<string,PublicTransaction>;expectedCursor:string|null;started:boolean;ended:boolean;head?:string;related?:Map<string,PublicTransaction>}>();
async function readPositionFlowAuditUnlocked(positionId:string,source:"live"|"captured-public",before?:string,fetcher:typeof fetch=fetch,signal?:AbortSignal,analyze=false){
  if(source==="captured-public"){
    const dir=join(process.cwd(),"specs/lp-decision/fixtures");
    // The replay reads evidence captured on this machine; none ships with the repository.
    const fixture=async(name:string)=>JSON.parse(await readFile(join(dir,`${name}.json`),"utf8").catch(()=>{throw new Error("No captured public evidence is installed");}));
    const selected=await fixture("selected-public-position");
    if(selected.positionMint!==positionId)throw new Error("No captured public evidence for this position");
    const pool=(await fixture("raydium-pool")).data[0],signatures=(await fixture("rpc-position-signatures")).result;
    const transactions=await Promise.all(signatures.map(async(s:{signature:string})=>({signature:s.signature,tx:(await fixture(`rpc-position-tx-${s.signature}`)).result as PublicTransaction})));
    const context:FlowContext={poolId:selected.poolId,positionId,positionAccount:selected.positionAccount,mintA:pool.mintA.address,mintB:pool.mintB.address,decimalsA:pool.mintA.decimals,decimalsB:pool.mintB.decimals};
    const signature=(await readdir(join(dir,"closure"))).find(name=>name.startsWith("related-tx-"))?.slice("related-tx-".length,-".json".length);
    if(!signature)throw new Error("No captured public evidence is installed");
    const related=(await fixture(`closure/related-tx-${signature}`)).result;
    const relatedNftRent=observedNftRentRefund(signature,related,(await fixture("closure/exit-simulation-context")).addresses[2],positionId);
    const historicalMarks=await readCapturedHistoricalMarks(),classified=classifyPositionJournal(transactions,context),prices:Record<string,PriceRange>={};
    for(const m of historicalMarks.rows)if(m.status==="reference-mark"&&m.priceUSDC!==null)prices[`${m.signature}:${m.mint==="So11111111111111111111111111111111111111112"?"SOL":m.mint}`]={lower:m.priceUSDC,upper:m.priceUSDC,source:m.source,observedAt:m.sourceEnd,ageSeconds:m.ageSeconds,kind:"reference-mark"};
    const positionEntry=(await fixture("rpc-public-positions")).result.find((p:{pubkey:string})=>p.pubkey===selected.positionAccount),snapshot=PersonalPositionLayout.decode(Buffer.from(positionEntry.account.data[0],"base64"));
    const coverage={historyReachedEnd:true,currentLiquidity:snapshot.liquidity.toString(),relatedAccountsComplete:true};
    const accounting={...analyzePositionLedger(classified,coverage,prices,[],{},commonCostBounds([...transactions,{signature,tx:related}],classified.audit),false),journal:classified.journal,replayOnly:true,equityBasis:"Captured replay has no current account valuation; never a current holding result"};
    return {accounting,historicalMarks,relatedNftRent,source:{kind:source,asOf:selected.fetchedAt,fresh:false,synthetic:false},context,historyReachedEnd:true,nextCursor:null,...auditPositionFlows(transactions,context)};
  }
  const budget=AbortSignal.any([AbortSignal.timeout(25000),...(signal?[signal]:[])]);
  const rpc=async(method:string,params:unknown[])=>rpcRequest(method,params,{fetcher,signal:budget,timeoutMs:10000});
  const positionAccount=getPdaPersonalPositionAddress(CLMM_PROGRAM_ID,new PublicKey(positionId)).publicKey.toBase58();
  const decoded=async(address:string,name:string)=>{
    const response=await rpc("getAccountInfo",[address,{encoding:"base64",commitment:"confirmed"}]);
    const value=response?.value,bytes=value?.data?Buffer.from(value.data[0],"base64"):null;
    if(!bytes||value.owner!==CLMM_PROGRAM_ID.toBase58()||!bytes.subarray(0,8).equals(createHash("sha256").update(`account:${name}`).digest().subarray(0,8)))throw new Error(`${name} account missing or invalid`);
    return bytes;
  };
  for(const [key,value] of livePages)if(Date.now()-value.at>900000)livePages.delete(key);
  if(livePages.size>=20&&!livePages.has(positionId))livePages.delete(livePages.keys().next().value!);
  let page=livePages.get(positionId);if(!page||Date.now()-page.at>900000){page={at:Date.now(),transactions:new Map(),expectedCursor:null,started:false,ended:false};livePages.set(positionId,page);}
  const position=PersonalPositionLayout.decode(await decoded(positionAccount,"PersonalPositionState"));
  if(position.nftMint.toBase58()!==positionId)throw new Error("NFT context mismatch");
  const poolId=position.poolId.toBase58(),pool=PoolInfoLayout.decode(await decoded(poolId,"PoolState"));
  const context:FlowContext={positionAccount,poolId,positionId,mintA:pool.mintA.toBase58(),mintB:pool.mintB.toBase58(),decimalsA:pool.mintDecimalsA,decimalsB:pool.mintDecimalsB};
  const contiguous=before? page.started&&page.expectedCursor===before:true;
  const signatures=await rpc("getSignaturesForAddress",[positionAccount,{limit:10,commitment:"confirmed",...(before?{before}:{})}]);
  if(!Array.isArray(signatures))throw new Error("Signature page invalid");
  const reuseComplete=!before&&page.ended&&page.head===signatures[0]?.signature;
  if(!before&&!reuseComplete){if(page.head!==signatures[0]?.signature){page.transactions.clear();page.related?.clear();}page.started=true;page.expectedCursor=null;page.ended=false;page.head=signatures[0]?.signature;}
  const transactions:{signature:string;tx:PublicTransaction}[]=[],errors:{signature:string;detail:string}[]=[];
  for(const s of signatures){
    if(budget.aborted)break;
    try{const tx=page.transactions.get(s.signature)??await rpc("getTransaction",[s.signature,{encoding:"jsonParsed",commitment:"confirmed",maxSupportedTransactionVersion:0}]);if(!tx)throw new Error("Transaction pruned/unavailable");transactions.push({signature:s.signature,tx});page.transactions.set(s.signature,tx);}
    catch(e){errors.push({signature:s.signature,detail:e instanceof Error?e.message:"Transaction unavailable"});break;}
  }
  // Resume before the last successfully read signature, never skip a failed tx.
  const nextCursor=transactions.length?transactions.at(-1)!.signature:before??null;
  const reachedEnd=signatures.length<10&&transactions.length===signatures.length;
  if(contiguous&&!reuseComplete){page.expectedCursor=nextCursor;page.ended=reachedEnd;}page.at=Date.now();
  const all=analyze?[...page.transactions].map(([signature,tx])=>({signature,tx})):transactions;
  let relatedAccountsComplete=false;const relatedTransactions:{signature:string;tx:PublicTransaction}[]=[],rentRefunds:ReturnType<typeof observedNftRentRefund>[]=[];
  if(analyze&&page.ended&&contiguous){
    try{const balances=all.flatMap(t=>t.tx.meta?.postTokenBalances?.filter(b=>b.mint===positionId&&b.uiTokenAmount.amount==="1").map(b=>({balance:b,key:t.tx.transaction?.message.accountKeys[b.accountIndex]}))??[]);
      const latest=balances[0],nftAddress=typeof latest?.key==="string"?latest.key:latest?.key?.pubkey;
      if(!nftAddress)throw new Error("Current NFT account candidate unavailable");
      const value=(await rpc("getAccountInfo",[nftAddress,{encoding:"base64",commitment:"confirmed"}]))?.value;
      if(!value||![TOKEN_PROGRAM_ID.toBase58(),TOKEN_2022_PROGRAM_ID.toBase58()].includes(value.owner))throw new Error("Current NFT token program invalid");
      const current=unpackAccount(new PublicKey(nftAddress),{...value,data:Buffer.from(value.data[0],"base64"),owner:new PublicKey(value.owner)},new PublicKey(value.owner));
      if(current.mint.toBase58()!==positionId||current.amount!==1n||current.owner.toBase58()!==latest?.balance.owner)throw new Error("NFT owner changed; scoped history needs ownership boundary");
      relatedAccountsComplete=true;
      const relatedSignatures=new Set<string>();for(const address of [positionId,nftAddress]){const rows=await rpc("getSignaturesForAddress",[address,{limit:1000,commitment:"confirmed"}]);if(!Array.isArray(rows))throw new Error("NFT signature result invalid");if(rows.length===1000)relatedAccountsComplete=false;for(const r of rows)relatedSignatures.add(r.signature);}
      for(const signature of relatedSignatures){if(page.transactions.has(signature))continue;page.related??=new Map();const tx=page.related.get(signature)??await rpc("getTransaction",[signature,{encoding:"jsonParsed",commitment:"confirmed",maxSupportedTransactionVersion:0}]) as PublicTransaction|null;if(!tx){relatedAccountsComplete=false;continue;}page.related.set(signature,tx);relatedTransactions.push({signature,tx});rentRefunds.push(observedNftRentRefund(signature,tx,nftAddress,positionId));}
    }catch(e){relatedAccountsComplete=false;errors.push({signature:"NFT-related cost scope",detail:e instanceof Error?e.message:"NFT history unavailable"});}
  }
  const coverage={relatedAccountsComplete,historyReachedEnd:analyze?page.ended&&contiguous:reachedEnd,currentLiquidity:position.liquidity.toString()};
  const audit=auditPositionFlows(all,context,coverage);
  let accounting;let accountingAsOf:string|undefined;
  if(analyze){
    const classified=classifyPositionJournal(all,context),now=Math.floor(Date.now()/1000);
    let snapshot:Awaited<ReturnType<typeof readCurrentEquity>>|undefined;
    try{snapshot=await readCurrentEquity(positionId,positionAccount,pool,position,rpc);coverage.currentLiquidity=snapshot.liquidity;}catch(e){errors.push({signature:"Current income snapshot",detail:e instanceof Error?e.message:"Snapshot unavailable"});}
    try{const latest=await rpc("getSignaturesForAddress",[positionAccount,{limit:1,commitment:"confirmed",...(snapshot?{minContextSlot:snapshot.slot}:{})}]);
      if(!historySnapshotMatches(page.head,latest))throw new Error("Position changed during read; restart at newest history head");
    }catch(e){page.ended=false;coverage.historyReachedEnd=false;errors.push({signature:"History/snapshot head",detail:e instanceof Error?e.message:"History/snapshot head unavailable"});}
    const requests=historicalPositionMarks(classified,all,[context.mintA,context.mintB]);
    requests.push(...[...all,...relatedTransactions].filter(t=>t.tx.blockTime!==null).map(t=>({signature:t.signature,mint:"SOL",time:t.tx.blockTime!})),...[...new Set([context.mintA,context.mintB,...(snapshot?.equity.map(e=>e.mint)??[])])].map(mint=>({signature:"current",mint,time:snapshot?.chainTime??now})));
    const currentRequests=requests.filter(r=>r.signature==="current"),historicRequests=requests.filter(r=>r.signature!=="current");
    const unique=[...new Map([...currentRequests,...historicRequests].map(r=>[`${r.signature}:${r.mint}`,r])).values()];
    const marks=await liveReferenceMarks(unique,fetcher,budget);
    const equity=snapshot?.equity??[];accountingAsOf=snapshot?new Date(snapshot.chainTime*1000).toISOString():undefined;
    const currentPrices:Record<string,PriceRange>={};for(const mint of [...new Set([context.mintA,context.mintB,...equity.map(e=>e.mint)])]){const mark=marks.marks[`current:${mint}`];if(mark)currentPrices[mint]=mark;}
    accounting={...analyzePositionLedger(classified,coverage,marks.marks,equity,currentPrices,commonCostBounds([...all,...relatedTransactions],audit),!!snapshot),rentRefunds,journal:classified.journal,pricePolicy:marks.policy,priceAttempts:marks.attempts,prices:marks.marks,equityBasis:snapshot?.basis??"Current inventory unavailable; no zero substitute",equitySnapshot:snapshot?{slot:snapshot.slot,chainTime:snapshot.chainTime}:null};
  }
  return {source:{kind:source,asOf:accountingAsOf??new Date().toISOString(),fresh:true,synthetic:false},context,historyReachedEnd:coverage.historyReachedEnd,nextCursor:errors.some(e=>e.signature==="History/snapshot head")||reachedEnd||reuseComplete?null:nextCursor,errors,accounting,...audit};
}

// Serialize each position's pagination updates; failures cannot overwrite another
// client’s completed page. Locks expire on settlement and do not store credentials.
const positionReads=new Map<string,Promise<unknown>>();
export async function readPositionFlowAudit(positionId:string,source:"live"|"captured-public",before?:string,fetcher:typeof fetch=fetch,signal?:AbortSignal,analyze=false){
 const prior=positionReads.get(positionId)??Promise.resolve();
 const run=prior.catch(()=>undefined).then(()=>{if(signal?.aborted)throw new Error("Read cancelled");return readPositionFlowAuditUnlocked(positionId,source,before,fetcher,signal,analyze);});
 positionReads.set(positionId,run);try{return await run;}finally{if(positionReads.get(positionId)===run)positionReads.delete(positionId);}
}
