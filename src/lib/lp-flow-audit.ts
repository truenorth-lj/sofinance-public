import { observedNetworkCost } from "./lp-network-cost";
import { observePositionTransaction, type PublicTransaction } from "./lp-position-observations";
const CLMM="CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK";
const COMPUTE="ComputeBudget111111111111111111111111111111";
export type FlowContext={poolId:string;positionId:string;positionAccount:string;mintA:string;mintB:string;decimalsA:number;decimalsB:number};
const safeLamports=(value:unknown)=>typeof value==="number"&&Number.isSafeInteger(value)&&value>=0?BigInt(value):null;
export function auditPositionFlows(transactions:{signature:string;tx:PublicTransaction}[],context:FlowContext,coverage?:{historyReachedEnd:boolean;currentLiquidity:string|null;walletHistoryComplete?:boolean;walletBalancesReconciled?:boolean}){
  const totals={networkAndPriorityLamports:0n,directPositionRentPaidLamports:0n,networkLamports:0n,priorityLamports:0n};
  const movements:Record<string,{deposits:string;withdrawnPrincipal:string;paidFees:string;paidRewards:string}>={};
  const add=(mint:string,kind:keyof (typeof movements)[string],amount:string)=>{const row=movements[mint]??={deposits:"0",withdrawnPrincipal:"0",paidFees:"0",paidRewards:"0"};row[kind]=(BigInt(row[kind])+BigInt(amount)).toString();};
  const seen=new Set<string>();
  const rows=transactions.map(({signature,tx})=>{
    const observation=observePositionTransaction(signature,tx,context),e=observation.evidence;
    const keys=tx.transaction?.message.accountKeys??[],accountAt=(i:number)=>typeof keys[i]==="string"?keys[i] as string:(keys[i] as {pubkey:string}|undefined)?.pubkey;
    const nftOwners=[...new Set(e.tokenBalances.filter(b=>b.mint===context.positionId&&(b.preAtomic==="1"||b.postAtomic==="1")).map(b=>b.owner).filter((owner):owner is string=>!!owner))];
    const owner=nftOwners.length===1?nftOwners[0]!:null;
    const instructions=tx.transaction?.message.instructions??[];
    const duplicate=seen.has(signature);seen.add(signature);
    const exclusive=!duplicate&&observation.ledger.length>0&&owner===accountAt(0)&&instructions.filter(i=>i.programId===CLMM).length===1&&instructions.every(i=>[CLMM,COMPUTE].includes(i.programId??""));
    const tokenChecks=[context.mintA,context.mintB].map(mint=>{
      const pool=e.tokenBalances.filter(b=>b.mint===mint&&b.owner===context.poolId),wallet=e.tokenBalances.filter(b=>b.mint===mint&&b.owner===owner);
      const delta=(balances:typeof pool)=>balances.length&&balances.every(b=>b.deltaAtomic!==null)?balances.reduce((n,b)=>n+BigInt(b.deltaAtomic!),0n):null;
      const poolDelta=delta(pool),walletDelta=delta(wallet),eventDelta=observation.ledger.filter(v=>v.mint===mint).reduce((n,v)=>n+BigInt(v.amountAtomic)*(["deposit","increase"].includes(v.kind)?1n:-1n),0n);
      const transferFee=e.transferFees.filter(f=>f.mint===mint).reduce((n,f)=>n+BigInt(f.amountAtomic),0n);
      return {mint,poolDeltaAtomic:poolDelta?.toString()??null,walletDeltaAtomic:walletDelta?.toString()??null,eventDeltaAtomic:eventDelta.toString(),transferFeeAtomic:transferFee.toString(),poolMatches:poolDelta===null?null:poolDelta===eventDelta,walletMatches:poolDelta===null||walletDelta===null?null:walletDelta===-poolDelta-transferFee};
    });
    const related=new Set([context.positionAccount,context.positionId,...e.tokenBalances.filter(b=>b.mint===context.positionId).map(b=>b.account)]);
    let rent=0n;const rentEvidence=e.rentInstructions.map(r=>{
      const amount=safeLamports(r.info.lamports),direct=(r.type.startsWith("createAccount")&&related.has(String(r.info.newAccount))||r.type==="transfer"&&related.has(String(r.info.destination)))&&r.info.source===owner&&amount!==null;
      if(direct)rent+=amount!;
      return {...r,directPositionCreation:direct,lamports:amount?.toString()??null};
    });
    const pre=safeLamports(tx.meta?.preBalances?.[0]),post=safeLamports(tx.meta?.postBalances?.[0]),fee=safeLamports(tx.meta?.fee);
    const solDelta=pre!==null&&post!==null?post-pre:null;
    const solMatches=exclusive&&solDelta!==null&&fee!==null&&rentEvidence.every(r=>r.directPositionCreation)?solDelta===-fee-rent:null;
    const networkCost=observedNetworkCost(tx);
    const reconciled=exclusive&&tokenChecks.every(c=>c.poolMatches&&c.walletMatches)&&solMatches===true;
    if(reconciled){totals.networkAndPriorityLamports+=fee!;totals.directPositionRentPaidLamports+=rent;if(networkCost.networkLamports!==null&&networkCost.priorityLamports!==null){totals.networkLamports+=BigInt(networkCost.networkLamports);totals.priorityLamports+=BigInt(networkCost.priorityLamports);}
      for(const event of observation.ledger)add(event.mint,["deposit","increase"].includes(event.kind)?"deposits":event.kind==="fee"?"paidFees":"withdrawnPrincipal",event.amountAtomic);
      for(const reward of e.rewardSlots)if(reward.matchedBalance&&reward.mint&&reward.recipientOwner===owner)add(reward.mint,"paidRewards",reward.amountAtomic);
    }
    return {signature,timestamp:e.timestamp,owner,networkCost,duplicateSignature:duplicate,exclusiveLPAction:exclusive,tokenChecks,networkAndPriorityLamports:fee?.toString()??null,directPositionRentPaidLamports:rent.toString(),rentEvidence,walletSolDeltaLamports:solDelta?.toString()??null,walletSolMatches:solMatches,scopedAtomicFlowsReconciled:reconciled,rewards:e.rewardSlots};
  });
  return {scope:"position-related transactions only" as const,rows,movements,verifiedTransactionCount:rows.filter(r=>r.scopedAtomicFlowsReconciled).length,totals:Object.fromEntries(Object.entries(totals).map(([k,v])=>[k,(["networkLamports","priorityLamports"].includes(k)&&rows.some(r=>r.scopedAtomicFlowsReconciled&&r.networkCost.networkLamports===null))?null:v.toString()])),completeWalletAccounting:!!(coverage?.walletHistoryComplete&&coverage?.walletBalancesReconciled),completeness:{positionHistory:coverage?.historyReachedEnd?"complete":"partial",walletAccounting:coverage?.walletHistoryComplete&&coverage?.walletBalancesReconciled?"complete":"not-collected"},netUSDC:null,unresolved:["Wallet-wide opening/closing balances, failed-transaction costs and transfers outside the position account history", "Fungible wallet funding provenance / reinvestment policy for HODL", "Historical USDC valuation for each mint and SOL", "Rent asset ownership/refund beyond this captured window"]};
}
