import { decodeRaydiumLiquidityEvent } from "./position-performance-events";
import type { LedgerEvent } from "./lp-accounting";
const CLMM = "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK";
type TokenBalance = { accountIndex: number; mint: string; owner?: string; uiTokenAmount: { amount: string; decimals: number } };
type ParsedInstruction = { data?: string; programId?: string; parsed?: { type: string; info: Record<string, unknown> } };
export type PublicTransaction = { slot: number; blockTime: number | null; transaction?: { message: { accountKeys: ({ pubkey: string } | string)[]; instructions?: ParsedInstruction[] } }; meta: { err: unknown; fee: number; logMessages: string[] | null; preTokenBalances?: TokenBalance[]; postTokenBalances?: TokenBalance[]; preBalances?: number[]; postBalances?: number[]; innerInstructions?: { index: number; instructions: ParsedInstruction[] }[] } | null };
export type TransactionEvidence = { signature: string; timestamp: string | null; slot: number; liquidityDelta: string; rewardSlots: { logIndex: number; slot: number; amountAtomic: string; mint: string | null; decimals: number | null; recipientOwner: string | null; matchedBalance: boolean }[]; transferFees: { logIndex: number; mint: string; amountAtomic: string }[]; tokenBalances: { account: string; mint: string; owner: string | null; decimals: number; preAtomic: string | null; postAtomic: string | null; deltaAtomic: string | null }[]; rentInstructions: { instructionIndex: string; type: string; info: Record<string, unknown> }[]; attribution: "unclassified" };
export function observePositionTransaction(signature: string, tx: PublicTransaction, context: { poolId: string; positionId: string; mintA: string; mintB: string; decimalsA: number; decimalsB: number }) {
  const evidence: TransactionEvidence = { signature, timestamp: tx.blockTime === null ? null : new Date(tx.blockTime*1000).toISOString(), slot: tx.slot, liquidityDelta: "0", rewardSlots: [], transferFees: [], tokenBalances: [], rentInstructions: [], attribution: "unclassified" };
  const ledger: LedgerEvent[] = []; const source = "Solana confirmed getTransaction / scoped Raydium CLMM log";
  if (!tx.meta || tx.meta.err) return { ledger, evidence, networkAndPriorityLamports: null, source };
  const stack: string[] = [];
  for (const [eventIndex,line] of (tx.meta.logMessages ?? []).entries()) {
    const invoke = /^Program (\S+) invoke \[\d+\]$/.exec(line);
    if (invoke) { stack.push(invoke[1]!); continue; }
    if (/^Program \S+ (success|failed:)/.test(line)) { stack.pop(); continue; }
    if (stack.at(-1) !== CLMM || !line.startsWith("Program data: ")) continue;
    const bytes = Buffer.from(line.slice(14),"base64");
    const event = decodeRaydiumLiquidityEvent(bytes);
    if (!event || (event.kind === "open" ? event.poolState !== context.poolId : event.positionNftMint !== context.positionId)) continue;
    if(event.kind === "open") {
      const nftObserved=[...(tx.meta.preTokenBalances??[]),...(tx.meta.postTokenBalances??[])].some(b=>b.mint===context.positionId&&b.uiTokenAmount.amount==="1");
      const samePoolOpens=(tx.meta.logMessages??[]).filter(log=>log.startsWith("Program data: ")).map(log=>decodeRaydiumLiquidityEvent(Buffer.from(log.slice(14),"base64"))).filter(e=>e?.kind==="open"&&e.poolState===context.poolId);
      // CreatePersonalPositionEvent has no NFT mint. Ambiguous multi-open transactions
      // must not be attributed by pool alone.
      if(!nftObserved||samePoolOpens.length!==1)continue;
    }
    evidence.liquidityDelta = (BigInt(evidence.liquidityDelta) + BigInt(event.liquidity) * (event.kind === "decrease" ? -1n : 1n)).toString();
    if(event.kind === "decrease") for(let rewardSlot=0;rewardSlot<3;rewardSlot++) evidence.rewardSlots.push({logIndex:eventIndex,slot:rewardSlot,amountAtomic:bytes.readBigUInt64LE(88+rewardSlot*8).toString(),mint:null,decimals:null,recipientOwner:null,matchedBalance:false});
    const transferOffset = event.kind === "open" ? 144 : event.kind === "increase" ? 72 : 112;
    for(const [side,index] of [["A",0],["B",1]] as const) evidence.transferFees.push({logIndex:eventIndex,mint:context[`mint${side}`],amountAtomic:bytes.readBigUInt64LE(transferOffset+index*8).toString()});
    const timestamp = tx.blockTime === null ? null : new Date(tx.blockTime*1000).toISOString();
    for (const side of ["A","B"] as const) {
      const mint = context[`mint${side}`], decimals = context[`decimals${side}`];
      const entries = event.kind === "decrease" ? [["decrease", event[`principal${side}`]], ["fee", event[`fee${side}`]]] as const : [[event.kind === "open" ? "deposit" : "increase", event[`amount${side}`]]] as const;
      for (const [kind,amountAtomic] of entries) {
        // On-chain amount is observed; wallet attribution, reinvestment and event price
        // remain unresolved. An observation is NOT a classified external cash flow.
        ledger.push({ id:`${signature}:${eventIndex}:${kind}:${mint}`,chain:"solana",signature,eventIndex,timestamp,mint,decimals,amountAtomic,kind,source,account:"position",role:"unclassified",priceAtEvent:null,priceSource:null,priceTimestamp:null,numeraire:"USDC",costAlreadyIncluded:false });
      }
    }
  }
  // Only retain account evidence in transactions with a matching target event.
  // Account deltas may include other instructions; never classify them as LP income.
  if(ledger.length) {
    const keys = tx.transaction?.message.accountKeys ?? [];
    const accountAt = (index:number) => typeof keys[index] === "string" ? keys[index] as string : (keys[index] as {pubkey:string}|undefined)?.pubkey ?? `index:${index}`;
    const pre = tx.meta.preTokenBalances ?? [], post = tx.meta.postTokenBalances ?? [];
    const ids = new Set([...pre,...post].map(b=>`${b.accountIndex}:${b.mint}`));
    for(const id of ids) {
      const a=pre.find(b=>`${b.accountIndex}:${b.mint}`===id), b=post.find(b=>`${b.accountIndex}:${b.mint}`===id), sample=b??a!;
      // Missing balances are unknown, including creation/closure; do not default to zero.
      evidence.tokenBalances.push({account:accountAt(sample.accountIndex),mint:sample.mint,owner:sample.owner??null,decimals:sample.uiTokenAmount.decimals,preAtomic:a?.uiTokenAmount.amount??null,postAtomic:b?.uiTokenAmount.amount??null,deltaAtomic:a&&b?(BigInt(b.uiTokenAmount.amount)-BigInt(a.uiTokenAmount.amount)).toString():null});
    }
    const groups=[{index:"outer",instructions:tx.transaction?.message.instructions??[]},...(tx.meta.innerInstructions??[]).map(g=>({index:`inner:${g.index}`,instructions:g.instructions}))];
    for(const reward of evidence.rewardSlots) {
      if(reward.amountAtomic==="0")continue;
      const candidates=groups.flatMap(g=>g.instructions).filter(i=>["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA","TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"].includes(i.programId??"")&&i.parsed?.type==="transferChecked").map(i=>i.parsed!.info).filter(info=>info.authority===context.poolId && info.mint!==context.mintA && info.mint!==context.mintB && (info.tokenAmount as {amount?:string}|undefined)?.amount===reward.amountAtomic);
      if(candidates.length!==1 || evidence.rewardSlots.filter(r=>r.amountAtomic===reward.amountAtomic).length!==1)continue;
      const transfer=candidates[0]!, amount=transfer.tokenAmount as {amount:string;decimals:number};
      const outgoing=evidence.tokenBalances.find(b=>b.account===transfer.source&&b.mint===transfer.mint&&b.owner===context.poolId);
      const incoming=evidence.tokenBalances.find(b=>b.account===transfer.destination&&b.mint===transfer.mint);
      if(outgoing?.deltaAtomic!==`-${reward.amountAtomic}`||incoming?.deltaAtomic!==reward.amountAtomic)continue;
      reward.mint=String(transfer.mint);reward.decimals=amount.decimals;reward.recipientOwner=incoming.owner;reward.matchedBalance=true;
    }
    for(const group of groups) for(const [index,instruction] of group.instructions.entries()) {
      if(instruction.parsed && (["createAccount","createAccountWithSeed","closeAccount"].includes(instruction.parsed.type)||(instruction.programId==="11111111111111111111111111111111"&&instruction.parsed.type==="transfer"&&typeof instruction.parsed.info.lamports==="number"))) evidence.rentInstructions.push({instructionIndex:`${group.index}:${index}`,type:instruction.parsed.type,info:instruction.parsed.info});
    }
  }
  return { ledger, evidence, networkAndPriorityLamports: String(tx.meta.fee), source };
}
