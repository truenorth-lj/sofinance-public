import "server-only";
import { PublicKey } from "@solana/web3.js";
import { CLMM_PROGRAM_ID, getPdaPersonalPositionAddress, PersonalPositionLayout, PoolInfoLayout, LiquidityMathUtil, TickUtil } from "@raydium-io/raydium-sdk-v2";
import { createHash } from "node:crypto";
import { observePositionTransaction, type TransactionEvidence, type PublicTransaction } from "./lp-position-observations";
import type { DecisionRequest, LedgerEvent } from "./lp-accounting";
import { asRpcUserError } from "./rpc/errors";
import { rpcRequest } from "./rpc";
export function validPrincipalQuote(q: Record<string, unknown>, mint: string, amount: string): boolean {
  return q.inputMint===mint && q.outputMint==="EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" && q.inAmount===amount && q.swapMode==="ExactIn" && typeof q.outAmount==="string" && /^\d+$/.test(q.outAmount) && BigInt(q.outAmount)>0n && typeof q.otherAmountThreshold==="string" && /^\d+$/.test(q.otherAmountThreshold) && BigInt(q.otherAmountThreshold)<=BigInt(q.outAmount) && Array.isArray(q.routePlan) && q.routePlan.length>0;
}
const RPC_SOURCE = "solana-rpc";
export type DataAttempt = { source: string; status: "available" | "partial" | "error"; observedAt: string; detail: string };
export type DecisionObservations = {
  pool: null | { id: string; mintA: string; mintB: string; decimalsA: number; decimalsB: number; priceBPerA: string; feeRate: string; fetchedAt: string };
  position: null | { positionId: string; account: string; liquidityAtomic: string; signatureCount: number; signatureWindowComplete: boolean; transactionsRead: number; networkAndPriorityLamports: string };
  market: null | { source: string; fetchedAt: string; currency: "USD"; granularity: "day"; bars: number[][]; eventTimeValuation: false };
  exitPrincipal: null | { fetchedAt: string; amountAAtomic: string; amountBAtomic: string; quotes: { mint: string; inputAtomic: string; outputUSDCAtomic: string; thresholdUSDCAtomic: string; contextSlot: number | null; observedAt: string; expiresAt: null }[]; executable: false; netRecovery: null; missing: string[] };
  ledger: LedgerEvent[]; transactionEvidence: TransactionEvidence[]; attempts: DataAttempt[];
};
export async function readDecisionObservations(req: DecisionRequest, fetcher: typeof fetch = fetch, signal?: AbortSignal): Promise<DecisionObservations> {
  const result: DecisionObservations = {pool:null,position:null,market:null,exitPrincipal:null,ledger:[],transactionEvidence:[],attempts:[]};
  const budgetSignal = AbortSignal.any([AbortSignal.timeout(25000),...(signal?[signal]:[])]);
  const now = () => new Date().toISOString();
  async function json(url: string, body?: unknown) {
    const response = await fetcher(url,{method:body?"POST":"GET",headers:{"Content-Type":"application/json"},body:body?JSON.stringify(body):undefined,signal:AbortSignal.any([AbortSignal.timeout(10000),budgetSignal])});
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const value = await response.json(); if(value.error) throw new Error(`HTTP ${value.error.code}: ${value.error.message}`);return value;
  }
  const rpc = <T=unknown>(method: string, params: unknown[]) => rpcRequest<T>(method, params, { fetcher, signal: budgetSignal, timeoutMs: 10000 });
  let poolId = req.poolId;
  let account: string | undefined; let liquidityAtomic = ""; let positionState: ReturnType<typeof PersonalPositionLayout.decode> | undefined;
  if (req.positionId) {
    try {
      account=getPdaPersonalPositionAddress(CLMM_PROGRAM_ID,new PublicKey(req.positionId)).publicKey.toBase58();
      const response=await rpc<{value?:{data?:[string,string];owner:string}}>("getAccountInfo",[account,{encoding:"base64",commitment:"confirmed"}]);
      const value=response?.value; const bytes=value?.data ? Buffer.from(value.data[0],"base64") : null;
      if (!bytes || value.owner !== CLMM_PROGRAM_ID.toBase58() || !bytes.subarray(0,8).equals(createHash("sha256").update("account:PersonalPositionState").digest().subarray(0,8))) throw new Error("Personal position missing or invalid owner/discriminator");
      const decoded=PersonalPositionLayout.decode(bytes);
      if(decoded.nftMint.toBase58()!==req.positionId || (poolId && decoded.poolId.toBase58()!==poolId)) throw new Error("Position/pool context mismatch");
      positionState=decoded;poolId=decoded.poolId.toBase58();liquidityAtomic=decoded.liquidity.toString();
      result.attempts.push({source:RPC_SOURCE,status:"available",observedAt:now(),detail:"Personal position account owner, discriminator, NFT mint and pool verified"});
    } catch(e) {result.attempts.push({source:RPC_SOURCE,status:"error",observedAt:now(),detail:asRpcUserError(e).message});return result;}
  }
  if (!poolId) return result;
  try {
    const response=await json(`https://api-v3.raydium.io/pools/info/ids?ids=${encodeURIComponent(poolId)}`);
    const p=response.data?.[0];
    if (!response.success || p?.id!==poolId || p.programId!==CLMM_PROGRAM_ID.toBase58() || !p.mintA?.address || !p.mintB?.address || !Number.isFinite(p.price) || p.price<=0 || !Number.isFinite(p.feeRate)) throw new Error("Pool data missing or invalid");
    result.pool={id:poolId,mintA:p.mintA.address,mintB:p.mintB.address,decimalsA:p.mintA.decimals,decimalsB:p.mintB.decimals,priceBPerA:String(p.price),feeRate:String(p.feeRate),fetchedAt:now()};
    result.attempts.push({source:"Raydium pools/info/ids",status:"available",observedAt:now(),detail:"Public pool snapshot; price is B/A, not USDC valuation or executable quote"});
  }catch(e){result.attempts.push({source:"Raydium pools/info/ids",status:"error",observedAt:now(),detail:e instanceof Error?e.message:"Pool lookup failed"});return result;}
  try {
    const url=`https://api.geckoterminal.com/api/v2/networks/solana/pools/${poolId}/ohlcv/day?aggregate=1&limit=100&currency=usd&token=base`;
    const data=await json(url);const bars=data.data?.attributes?.ohlcv_list;
    if(!Array.isArray(bars)||!bars.length||!bars.every((b:unknown)=>Array.isArray(b)&&b.length===6&&b.every(v=>typeof v==="number"&&Number.isFinite(v))))throw new Error("USD daily candles missing/invalid");
    result.market={source:url,fetchedAt:now(),currency:"USD",granularity:"day",bars,eventTimeValuation:false};
    result.attempts.push({source:"GeckoTerminal OHLCV",status:"partial",observedAt:now(),detail:"Real USD daily candles; sampled price windows, not exact event-time USDC valuation or calibrated future model"});
  } catch(e){result.attempts.push({source:"GeckoTerminal OHLCV",status:"error",observedAt:now(),detail:e instanceof Error?e.message:"Market unavailable"});}
  if(positionState && result.pool) {
    try {
      const data=await rpc<{value?:{data?:[string,string];owner:string}}>("getAccountInfo",[poolId,{encoding:"base64",commitment:"confirmed"}]);
      const accountValue=data?.value;const bytes=accountValue?.data?Buffer.from(accountValue.data[0],"base64"):null;
      if(!bytes||accountValue.owner!==CLMM_PROGRAM_ID.toBase58()||!bytes.subarray(0,8).equals(createHash("sha256").update("account:PoolState").digest().subarray(0,8)))throw new Error("Pool account missing/invalid");
      const state=PoolInfoLayout.decode(bytes);
      if(state.mintA.toBase58()!==result.pool.mintA||state.mintB.toBase58()!==result.pool.mintB)throw new Error("Pool mint mismatch");
      const amounts=LiquidityMathUtil.getAmountsForLiquidity(state.sqrtPriceX64,TickUtil.getSqrtPriceAtTick(positionState.tickLower),TickUtil.getSqrtPriceAtTick(positionState.tickUpper),positionState.liquidity,false);
      result.exitPrincipal={fetchedAt:now(),amountAAtomic:amounts.amountA.toString(),amountBAtomic:amounts.amountB.toString(),quotes:[],executable:false,netRecovery:null,missing:["Snapshot consistency across RPC slots", "Withdrawal Token-2022 transfer fees and restrictions", "Unclaimed fees/rewards", "Network/priority/platform/rent costs", "Combined route simulation and quote expiry"]};
      const USDC="EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
      for(const [mint,inputAtomic] of [[result.pool.mintA,amounts.amountA.toString()],[result.pool.mintB,amounts.amountB.toString()]] as const) {
        if(inputAtomic==="0")continue;
        try {
          const q=await json(`https://api.jup.ag/swap/v1/quote?inputMint=${mint}&outputMint=${USDC}&amount=${inputAtomic}&slippageBps=50`);
          if(!validPrincipalQuote(q,mint,inputAtomic))throw new Error("Quote context/amount/route invalid");
          result.exitPrincipal.quotes.push({mint,inputAtomic,outputUSDCAtomic:q.outAmount,thresholdUSDCAtomic:q.otherAmountThreshold,contextSlot:Number.isSafeInteger(q.contextSlot)?q.contextSlot:null,observedAt:now(),expiresAt:null});
        }catch(e){result.attempts.push({source:"Jupiter principal-only quote",status:"error",observedAt:now(),detail:e instanceof Error?e.message:"Quote unavailable"});}
      }
      result.attempts.push({source:"Raydium liquidity math / Jupiter GET quote",status:"partial",observedAt:now(),detail:"Read-only principal token amounts and independent swap route observations; not a full withdraw+swap executable net quote. No quote expiry supplied; no build/sign/broadcast."});
    }catch(e){result.attempts.push({source:"Exit principal snapshot",status:"error",observedAt:now(),detail:e instanceof Error?e.message:"Snapshot unavailable"});}
  }
  if (account && req.positionId && result.pool) {
    try {
      const signatures=await rpc<{signature:string}[]>("getSignaturesForAddress",[account,{limit:10,commitment:"confirmed"}]);
      if(!Array.isArray(signatures))throw new Error("Signature result missing");
      let combinedFee=0n;let transactionsRead=0;
      for(const item of [...signatures].reverse()) {
        if(budgetSignal.aborted)break;
        try {
          const tx=await rpc<PublicTransaction | null>("getTransaction",[item.signature,{encoding:"jsonParsed",commitment:"confirmed",maxSupportedTransactionVersion:0}]);
          if(!tx)throw new Error("Transaction pruned/unavailable");
          const observed=observePositionTransaction(item.signature,tx,{poolId,positionId:req.positionId,...result.pool});
          result.ledger.push(...observed.ledger);result.transactionEvidence.push(observed.evidence);transactionsRead++;
          if(observed.networkAndPriorityLamports!==null)combinedFee+=BigInt(observed.networkAndPriorityLamports);
        }catch(e){result.attempts.push({source:`RPC transaction ${item.signature}`,status:"error",observedAt:now(),detail:asRpcUserError(e).message});if(budgetSignal.aborted || (e instanceof Error && /429|rate[- ]?limit|temporarily unavailable/i.test(e.message)))break;}
      }
      result.position={positionId:req.positionId,account,liquidityAtomic,signatureCount:signatures.length,signatureWindowComplete:signatures.length<10 && transactionsRead===signatures.length,transactionsRead,networkAndPriorityLamports:combinedFee.toString()};
      result.attempts.push({source:RPC_SOURCE,status:"partial",observedAt:now(),detail:"Bounded 10-signature raw history, no wallet discovery; historical USDC prices, reward/transfer attribution and full balance reconciliation unresolved. meta.fee includes network+priority, not split."});
    }catch(e){result.attempts.push({source:RPC_SOURCE,status:"error",observedAt:now(),detail:asRpcUserError(e).message});}
  }
  return result;
}
