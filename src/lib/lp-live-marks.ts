import "server-only";
import { priorMinuteMark } from "./lp-price-evidence";
import type { PriceRange } from "./lp-ledger-analysis";
const USDC="EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",SOL="So11111111111111111111111111111111111111112";
type Pool={id:string;side:string};
const poolCache=new Map<string,{at:number;pools:Pool[]}>(),barCache=new Map<string,{at:number;bars:number[][];source:string}>();
let unavailableUntil=0;
export async function liveReferenceMarks(requests:{signature:string;mint:string;time:number}[],fetcher:typeof fetch,signal:AbortSignal){
 for(const cache of [poolCache,barCache]){for(const [key,value] of cache)if(Date.now()-value.at>3600000)cache.delete(key);while(cache.size>512)cache.delete(cache.keys().next().value!);}
 const marks:Record<string,PriceRange>={},attempts:{source:string;status:string;detail:string;observedAt:string}[]=[];
 const json=async(url:string)=>{if(Date.now()<unavailableUntil)throw new Error("GeckoTerminal rate-limit backoff active; retry later");const response=await fetcher(url,{signal:AbortSignal.any([signal,AbortSignal.timeout(10000)])});if(response.status===429)unavailableUntil=Date.now()+60000;if(!response.ok)throw new Error(`GeckoTerminal HTTP ${response.status}`);return response.json();};
 for(const request of requests){if(signal.aborted)break;const mint=request.mint==="SOL"?SOL:request.mint,key=`${request.signature}:${request.mint}`;
  if(mint===USDC){marks[key]={lower:"1",upper:"1",source:"USDC numeraire identity (not USD peg)",observedAt:new Date(request.time*1000).toISOString(),ageSeconds:0,kind:"reference-mark"};continue;}
  try{
   let cached=poolCache.get(mint);if(!cached||Date.now()-cached.at>3600000){const url=`https://api.geckoterminal.com/api/v2/networks/solana/tokens/${mint}/pools?page=1`,data=await json(url);
    const pools=(data.data??[]).filter((p:{relationships:{base_token:{data:{id:string}};quote_token:{data:{id:string}}}})=>[p.relationships.base_token.data.id,p.relationships.quote_token.data.id].includes(`solana_${USDC}`)&&[p.relationships.base_token.data.id,p.relationships.quote_token.data.id].includes(`solana_${mint}`)).slice(0,3).map((p:{attributes:{address:string};relationships:{base_token:{data:{id:string}};quote_token:{data:{id:string}}}})=>({id:p.attributes.address,side:p.relationships.base_token.data.id===`solana_${mint}`?"base":"quote"}));cached={at:Date.now(),pools};poolCache.set(mint,cached);}
   const observations:{price:string;source:string;age:number;end:string}[]=[];
   for(const pool of cached.pools){if(signal.aborted)break;try{const minute=Math.floor(request.time/60)*60,cacheKey=`${pool.id}:${pool.side}:${minute}`;let data=barCache.get(cacheKey);
    if(!data||Date.now()-data.at>3600000){const source=`https://api.geckoterminal.com/api/v2/networks/solana/pools/${pool.id}/ohlcv/minute?aggregate=1&limit=10&before_timestamp=${minute}&currency=token&token=${pool.side}`;const response=await json(source),bars=response.data?.attributes?.ohlcv_list;if(!Array.isArray(bars))throw new Error("Minute bars invalid");data={at:Date.now(),bars,source};barCache.set(cacheKey,data);}
    const mark=priorMinuteMark(request.time,data.bars,60);if(mark.status==="reference-mark")observations.push({price:mark.priceUSDC,source:data.source,age:mark.ageSeconds,end:mark.sourceEnd});
    }catch(e){attempts.push({source:pool.id,status:"error",detail:e instanceof Error?e.message:"Pool price unavailable",observedAt:new Date().toISOString()});}
   }
   if(observations.length){const values=observations.map(o=>Number(o.price));marks[key]={lower:String(Math.min(...values)),upper:String(Math.max(...values)),source:observations.map(o=>o.source).join(" | "),observedAt:observations.map(o=>o.end).sort()[0]!,ageSeconds:Math.max(...observations.map(o=>o.age)),kind:"reference-mark"};}
   attempts.push({source:`Direct USDC pools ${mint}`,status:observations.length?"available":"missing",detail:`${observations.length}/${cached.pools.length} venues have completed prior minute within 60s. Envelope is observed venue dispersion, not confidence interval.`,observedAt:new Date().toISOString()});
  }catch(e){attempts.push({source:`Direct USDC pools ${mint}`,status:"error",detail:e instanceof Error?e.message:"Source unavailable",observedAt:new Date().toISOString()});}
 }
 return {marks,attempts,policy:"completed-prior-minute/60s/v1; up to 3 direct-USDC public venues; no empty-candle fill, no forward/curr-price backfill; observed envelope, not statistical coverage"};
}
