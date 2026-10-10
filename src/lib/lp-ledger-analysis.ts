import Decimal from "decimal.js";
import { observePositionTransaction, type PublicTransaction } from "./lp-position-observations";
import { auditPositionFlows, type FlowContext } from "./lp-flow-audit";
const D=Decimal.clone({precision:120});
export type PriceRange={lower:string;upper:string;source:string;observedAt:string;ageSeconds:number;kind:"reference-mark"|"exact-trade"};
export type JournalRow={id:string;signature:string;timestamp:string|null;mint:string;decimals:number;amountAtomic:string;grossAmountAtomic?:string;transferFeeAtomic?:string;kind:string;direction:"in"|"out";internalAtomic:string;classification:string;relatedIds:string[];poolVerified:boolean};
export type BoundedMetric={lower:string|null;upper:string|null;value:string|null;status:"reference-interval"|"partial"|"unavailable";missing:string[];basis:string};
export type CoverageInput={historyReachedEnd:boolean;currentLiquidity:string|null;walletHistoryComplete?:boolean;walletBalancesReconciled?:boolean;relatedAccountsComplete?:boolean};
export function classifyPositionJournal(transactions:{signature:string;tx:PublicTransaction}[],context:FlowContext){
 const audit=auditPositionFlows(transactions,context),journal:JournalRow[]=[],unknowns:{signature:string;reason:string}[]=[];
 const seen=new Set<string>();let liquiditySum=0n,openingSeen=false;
 for(const {signature,tx} of [...transactions].sort((a,b)=>(a.tx.blockTime??0)-(b.tx.blockTime??0)||a.tx.slot-b.tx.slot)){
  if(seen.has(signature))continue;seen.add(signature);
  const o=observePositionTransaction(signature,tx,context),a=audit.rows.find(r=>r.signature===signature)!;
  liquiditySum+=BigInt(o.evidence.liquidityDelta);openingSeen ||= o.ledger.some(e=>e.kind==="deposit");
  const rows:JournalRow[]=o.ledger.filter(e=>BigInt(e.amountAtomic)>0n).map(e=>({id:e.id,signature,timestamp:e.timestamp,mint:e.mint,decimals:e.decimals,amountAtomic:e.amountAtomic,kind:e.kind,direction:["deposit","increase"].includes(e.kind)?"in" as const:"out" as const,internalAtomic:"0",classification:e.kind==="fee"?"distributed-income":"position-boundary-capital",relatedIds:[] as string[],poolVerified:a.tokenChecks.every(c=>c.poolMatches===true)}));
  // Transfer fee is logged once per event/mint even when principal and fee
  // share the payout. Deduct income first, then principal; retain gross evidence.
  for(const fee of o.evidence.transferFees){let left=BigInt(fee.amountAtomic);if(left===0n)continue;
   const group=rows.filter(r=>r.mint===fee.mint&&r.id.startsWith(`${signature}:${fee.logIndex}:`)).sort((x,y)=>(x.kind==="fee"?-1:0)-(y.kind==="fee"?-1:0));
   if(group.some(r=>r.direction==="in")){const r=group[0]!;r.grossAmountAtomic=r.amountAtomic;r.transferFeeAtomic=left.toString();r.amountAtomic=(BigInt(r.amountAtomic)+left).toString();left=0n;}
   else for(const r of group){const gross=BigInt(r.amountAtomic),part=gross<left?gross:left;r.grossAmountAtomic=r.amountAtomic;r.transferFeeAtomic=part.toString();r.amountAtomic=(gross-part).toString();left-=part;}
   if(left>0n){unknowns.push({signature,reason:"Transfer fee exceeds matched event amount; boundary cash flow unverified"});for(const r of group)r.poolVerified=false;}
  }
  for(const r of o.evidence.rewardSlots)if(BigInt(r.amountAtomic)>0n&&r.mint&&r.decimals!==null&&r.matchedBalance&&r.recipientOwner===a.owner)rows.push({id:`${signature}:${r.logIndex}:reward:${r.mint}`,signature,timestamp:o.evidence.timestamp,mint:r.mint,decimals:r.decimals,amountAtomic:r.amountAtomic,kind:"reward",direction:"out",internalAtomic:"0",classification:"distributed-income",relatedIds:[],poolVerified:true});
  // Within one transaction, matched same-mint transfers are internal. No temporal
  // proximity rule claims that mixed fungible wallet inventory proves provenance.
  for(const incoming of rows.filter(r=>r.direction==="in"&&r.poolVerified))for(const outgoing of rows.filter(r=>r.direction==="out"&&r.poolVerified&&r.mint===incoming.mint)){
   const remainingIn=BigInt(incoming.amountAtomic)-BigInt(incoming.internalAtomic),remainingOut=BigInt(outgoing.amountAtomic)-BigInt(outgoing.internalAtomic),matched=remainingIn<remainingOut?remainingIn:remainingOut;
   if(matched<=0n)continue;incoming.internalAtomic=(BigInt(incoming.internalAtomic)+matched).toString();outgoing.internalAtomic=(BigInt(outgoing.internalAtomic)+matched).toString();incoming.relatedIds.push(outgoing.id);outgoing.relatedIds.push(incoming.id);incoming.classification=outgoing.classification="same-transaction internal netting";
  }
  const jupiter=(tx.transaction?.message.instructions??[]).some(i=>i.programId==="JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");
  if(jupiter&&rows.some(r=>r.direction==="in")&&rows.some(r=>r.classification==="distributed-income")){
   // Only net wallet residuals that are one input and one output are accepted.
   // Allocation is an explicit proportional income-first rule, not coin tracing.
   const walletChanges=new Map<string,bigint>();for(const b of o.evidence.tokenBalances.filter(b=>b.owner===a.owner&&b.deltaAtomic!==null&&b.mint!==context.positionId))walletChanges.set(b.mint,(walletChanges.get(b.mint)??0n)+BigInt(b.deltaAtomic!));
   const residuals=[...walletChanges].map(([mint,value])=>({mint,delta:value-rows.filter(r=>r.mint===mint).reduce((n,r)=>n+BigInt(r.amountAtomic)*(r.direction==="out"?1n:-1n),0n)})).filter(b=>b.delta!==0n);
   const negative=residuals.filter(b=>b.delta<0n),positive=residuals.filter(b=>b.delta>0n);
   const trustedOuter=(tx.transaction?.message.instructions??[]).every(i=>["CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK","JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4","ComputeBudget111111111111111111111111111111","ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"].includes(i.programId??"")),walletComplete=o.evidence.tokenBalances.filter(b=>b.owner===a.owner&&b.mint!==context.positionId).every(b=>b.deltaAtomic!==null);
   const hasExternalTransfer=(tx.transaction?.message.instructions??[]).some(i=>["transfer","transferChecked"].includes(i.parsed?.type??""));
   if(negative.length===1&&positive.length===1&&trustedOuter&&walletComplete&&!hasExternalTransfer&&rows.every(r=>r.poolVerified)){
    const from=negative[0]!,to=positive[0]!,income=rows.filter(r=>r.direction==="out"&&["fee","reward"].includes(r.kind)&&r.mint===from.mint),incoming=rows.filter(r=>r.direction==="in"&&r.mint===to.mint);
    const totalIncome=income.reduce((n,r)=>n+BigInt(r.amountAtomic)-BigInt(r.internalAtomic),0n),totalIncrease=incoming.reduce((n,r)=>n+BigInt(r.amountAtomic)-BigInt(r.internalAtomic),0n);
    if(totalIncome>=-from.delta&&totalIncrease>=to.delta){
     const spent=-from.delta,added=to.delta;
     for(const [group,total] of [[income,spent],[incoming,added]] as const){let left=total;for(const r of group){const free=BigInt(r.amountAtomic)-BigInt(r.internalAtomic),part=free<left?free:left;r.internalAtomic=(BigInt(r.internalAtomic)+part).toString();left-=part;r.classification="same-transaction claim → swap → reinvest (explicit income-first allocation)";r.relatedIds.push(...(group===income?incoming:income).map(x=>x.id));}}

    }else unknowns.push({signature,reason:"Same-transaction swap funding uses mixed inventory; reinvestment portion unproven"});
   }else unknowns.push({signature,reason:"Swap funding graph ambiguous; keep boundary cash flows and separate unknown provenance"});
  }
  if(!rows.every(r=>r.poolVerified))unknowns.push({signature,reason:"Pool deltas do not reconcile; affected journal rows excluded from verified subtotal"});
  if(o.evidence.rewardSlots.some(r=>BigInt(r.amountAtomic)>0n&&(!r.matchedBalance||!r.mint||r.decimals===null||r.recipientOwner!==a.owner)))unknowns.push({signature,reason:"Historical reward income positive but mint/recipient attribution incomplete"});
  journal.push(...rows);
 }
 const candidates=journal.filter(r=>r.direction==="in"&&r.internalAtomic!==r.amountAtomic).flatMap(r=>journal.filter(p=>p.direction==="out"&&["fee","reward"].includes(p.kind)&&p.mint===r.mint&&p.timestamp&&r.timestamp&&Date.parse(p.timestamp)<Date.parse(r.timestamp)).slice(-1).map(p=>({incomeId:p.id,increaseId:r.id,status:"unproven" as const,reason:"Cross-transaction same-mint matching is a candidate; wallet intervening flows not proven. Under position-boundary policy this remains a withdrawal then deposit."})));
 return {journal,unknowns,candidates,liquiditySum:liquiditySum.toString(),openingSeen,policy:"position-boundary/1: distributed income exits portfolio; later funding re-enters unless same-transaction netting/swap proves an internal path. Cross-transaction candidates never silently become compound.",audit};
}
export function positionCompleteness(classified:ReturnType<typeof classifyPositionJournal>,transactions:{signature:string;tx:PublicTransaction}[],coverage:CoverageInput){
 void transactions;
 const opening=classified.openingSeen,atomic=classified.journal.length>0&&classified.journal.every(r=>r.poolVerified),liquidityMatches=coverage.currentLiquidity!==null&&coverage.currentLiquidity===classified.liquiditySum;
 return {positionHistory:coverage.historyReachedEnd&&opening?"complete":"partial",liquidityMatches,positionAccounting:coverage.historyReachedEnd&&opening&&atomic&&liquidityMatches?"reconciled":"partial",positionAtomicFlows:atomic?"reconciled":"partial",incomeAccountProvenance:classified.unknowns.length||classified.candidates.length?"partial":"classified-under-boundary-policy",relatedAccountHistory:coverage.relatedAccountsComplete?"complete":"partial",walletAccounting:coverage.walletHistoryComplete&&coverage.walletBalancesReconciled?"complete":"not-collected",completeWalletAccounting:!!(coverage.walletHistoryComplete&&coverage.walletBalancesReconciled)};
}
export function commonCostBounds(transactions:{signature:string;tx:PublicTransaction}[],audit:ReturnType<typeof auditPositionFlows>){
 return [...new Map(transactions.map(t=>[t.signature,t])).values()].map(({signature,tx})=>{const row=audit.rows.find(r=>r.signature===signature),fee=tx.meta?.fee;
  const total=typeof fee==="number"&&Number.isSafeInteger(fee)&&fee>=0?String(fee):null;
  return {id:`${signature}:meta-fee`,signature,totalLamports:total,lowerLamports:row?.scopedAtomicFlowsReconciled?total:total===null?null:"0",upperLamports:total,allocation:row?.scopedAtomicFlowsReconciled?"exclusive verified LP transaction":"shared cost interval [0, full fee]; not exact single-LP attribution",alreadyIncluded:false};});
}
const range=(lo:string,hi:string)=>({lo:new D(lo),hi:new D(hi)});
const plus=(a:ReturnType<typeof range>,b:ReturnType<typeof range>)=>({lo:a.lo.add(b.lo),hi:a.hi.add(b.hi)});
const times=(a:ReturnType<typeof range>,b:ReturnType<typeof range>)=>{const values=[a.lo.mul(b.lo),a.lo.mul(b.hi),a.hi.mul(b.lo),a.hi.mul(b.hi)];return {lo:D.min(...values),hi:D.max(...values)};};
const price=(p:PriceRange|undefined)=>{try{if(!p||!p.source||!Number.isFinite(Date.parse(p.observedAt))||!Number.isFinite(p.ageSeconds)||p.ageSeconds<0||p.ageSeconds>60)return null;const lo=new D(p.lower),hi=new D(p.upper);return lo.isFinite()&&hi.isFinite()&&lo.gt(0)&&hi.gte(lo)?range(p.lower,p.upper):null;}catch{return null;}};
export function analyzePositionLedger(classified:ReturnType<typeof classifyPositionJournal>,coverage:CoverageInput,prices:Record<string,PriceRange>,equity:{mint:string;decimals:number;amountAtomic:string}[],currentPrices:Record<string,PriceRange>,costs:ReturnType<typeof commonCostBounds>,pendingIncomeComplete:boolean){
 const basis=classified.policy+" Prices are source-observed reference envelopes, not confidence intervals. Rent funding/refunds are assets, not full expenses.";
 const missing:string[]=[],components:{id:string;lower:string|null;upper:string|null;reason?:string}[]=[];let sum=range("0","0"),lowerUnknown=false,upperUnknown=false;
 const add=(id:string,quantity:string,decimals:number,p:PriceRange|undefined,sign:1|-1)=>{const mark=price(p),q=new D(quantity).div(new D(10).pow(decimals));if(q.isZero())return;if(!mark){components.push({id,lower:null,upper:null,reason:"Event/current mark unavailable"});missing.push(id);if(sign===1)upperUnknown=true;else lowerUnknown=true;return;}const v=times(range(q.toFixed(),q.toFixed()),mark),signed=sign===1?v:{lo:v.hi.neg(),hi:v.lo.neg()};sum=plus(sum,signed);components.push({id,lower:signed.lo.toFixed(),upper:signed.hi.toFixed()});};
 for(const r of classified.journal){if(!r.poolVerified){lowerUnknown=upperUnknown=true;missing.push(r.id);continue;}const external=(BigInt(r.amountAtomic)-BigInt(r.internalAtomic)).toString();add(r.id,external,r.decimals,prices[`${r.signature}:${r.mint}`],r.direction==="out"?1:-1);}
 for(const e of equity)add(`equity:${e.mint}`,e.amountAtomic,e.decimals,currentPrices[e.mint],1);
 for(const c of costs){const p=price(prices[`${c.signature}:SOL`]);if(!p||c.lowerLamports===null||c.upperLamports===null){lowerUnknown=true;missing.push(c.id);continue;}const val=times(range(new D(c.lowerLamports).div(1e9).toFixed(),new D(c.upperLamports).div(1e9).toFixed()),p);sum=plus(sum,{lo:val.hi.neg(),hi:val.lo.neg()});components.push({id:c.id,lower:val.hi.neg().toFixed(),upper:val.lo.neg().toFixed()});}
 if(!coverage.historyReachedEnd||!classified.openingSeen||coverage.currentLiquidity!==classified.liquiditySum){lowerUnknown=upperUnknown=true;missing.push("Full opening-to-asOf history unavailable");}
 if(!coverage.relatedAccountsComplete){lowerUnknown=true;missing.push("Related NFT/account cost history incomplete; additional costs unbounded");}
 if(classified.unknowns.some(u=>u.reason.includes("reward income"))){upperUnknown=true;missing.push("Historical reward valuation/attribution incomplete");}
 if(!pendingIncomeComplete){upperUnknown=true;missing.push("Unclaimed reward/fee inventory not completely valued");}
 const historical:BoundedMetric={lower:lowerUnknown?null:sum.lo.toFixed(),upper:upperUnknown?null:sum.hi.toFixed(),value:null,status:lowerUnknown&&upperUnknown?"unavailable":lowerUnknown||upperUnknown?"partial":"reference-interval",missing,basis};
 // Interval HODL with identical net boundary funding and proportional withdrawals.
 const basket:Record<string,ReturnType<typeof range>>={},hodlMissing:string[]=[];let deposited=range("0","0"),withdrawn=range("0","0");
 const groups=Map.groupBy(classified.journal,r=>r.signature);
 for(const [signature,rows] of groups){let withdrawal=range("0","0");for(const r of rows){const qty=new D(BigInt(r.amountAtomic)-BigInt(r.internalAtomic)).div(new D(10).pow(r.decimals));if(qty.isZero())continue;const p=price(prices[`${signature}:${r.mint}`]);if(!p||!r.poolVerified){hodlMissing.push(r.id);continue;}const v=times(range(qty.toFixed(),qty.toFixed()),p);if(r.direction==="in"){basket[r.mint]=plus(basket[r.mint]??range("0","0"),range(qty.toFixed(),qty.toFixed()));deposited=plus(deposited,v);}else withdrawal=plus(withdrawal,v);}
  if(withdrawal.hi.gt(0)){let value=range("0","0");for(const [mint,q] of Object.entries(basket)){const p=price(prices[`${signature}:${mint}`]);if(!p){hodlMissing.push(`${signature}:HODL basket mark ${mint}`);continue;}value=plus(value,times(q,p));}if(value.lo.lte(0)||withdrawal.hi.gt(value.lo)){hodlMissing.push(`${signature}:HODL withdrawal cannot be bounded within basket`);continue;}const remaining={lo:new D(1).sub(withdrawal.hi.div(value.lo)),hi:new D(1).sub(withdrawal.lo.div(value.hi))};for(const mint of Object.keys(basket))basket[mint]=times(basket[mint]!,remaining);withdrawn=plus(withdrawn,withdrawal);}
 }
 let hodlEquity=range("0","0");for(const [mint,q] of Object.entries(basket)){const p=price(currentPrices[mint]);if(!p)hodlMissing.push(`HODL current mark ${mint}`);else hodlEquity=plus(hodlEquity,times(q,p));}
 if(!coverage.historyReachedEnd||!classified.openingSeen||coverage.currentLiquidity!==classified.liquiditySum)hodlMissing.push("HODL opening history incomplete");
 const h=plus(plus(hodlEquity,withdrawn),{lo:deposited.hi.neg(),hi:deposited.lo.neg()});
 const hodl:BoundedMetric={lower:hodlMissing.length?null:h.lo.toFixed(),upper:hodlMissing.length?null:h.hi.toFixed(),value:null,status:hodlMissing.length?"unavailable":"reference-interval",missing:hodlMissing,basis:"Same net position-boundary deposits/withdrawals; proportional basket extraction. "+basis};
 const excess:BoundedMetric={lower:historical.lower!==null&&hodl.upper!==null?new D(historical.lower).sub(hodl.upper).toFixed():null,upper:historical.upper!==null&&hodl.lower!==null?new D(historical.upper).sub(hodl.lower).toFixed():null,value:null,status:historical.lower!==null&&historical.upper!==null&&hodl.lower!==null&&hodl.upper!==null?"reference-interval":(historical.lower!==null&&hodl.upper!==null)||(historical.upper!==null&&hodl.lower!==null)?"partial":"unavailable",missing:[...historical.missing,...hodl.missing],basis};
 return {historical,hodl,excess,components,knownSubtotal:{lower:components.some(c=>c.lower!==null)?sum.lo.toFixed():null,upper:components.some(c=>c.upper!==null)?sum.hi.toFixed():null,pricedComponents:components.filter(c=>c.lower!==null&&c.upper!==null).length,label:"Verified valued components subtotal only; not full net PnL"},costs,classification:{policy:classified.policy,unknowns:classified.unknowns,crossTransactionCandidates:classified.candidates},completeness:positionCompleteness(classified,[],coverage)};
}

export function historicalPositionMarks(classified:ReturnType<typeof classifyPositionJournal>,transactions:{signature:string;tx:PublicTransaction}[],basketMints:string[]){
 const requests=classified.journal.filter(r=>r.timestamp).map(r=>({signature:r.signature,mint:r.mint,time:Date.parse(r.timestamp!)/1000}));
 requests.push(...transactions.filter(t=>t.tx.blockTime!==null).flatMap(t=>basketMints.map(mint=>({signature:t.signature,mint,time:t.tx.blockTime!}))));
 return [...new Map(requests.map(r=>[`${r.signature}:${r.mint}`,r])).values()];
}

export function historySnapshotMatches(expectedHead:string|undefined,latest:{signature:string}[]){
 return Array.isArray(latest)&&latest.length<=1&&expectedHead===latest[0]?.signature;
}
