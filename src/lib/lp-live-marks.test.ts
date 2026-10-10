import {expect,it,vi} from "vitest";
vi.mock("server-only",()=>({}));
import {liveReferenceMarks} from "./lp-live-marks";
it("uses three direct-USDC venues, rejects future bars, preserves observed marks when another venue is rate-limited",async()=>{
 const mint="unit-token",usdc="EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
 const fetcher=vi.fn(async(url:unknown)=>{
  if(String(url).includes("/tokens/"))return Response.json({data:[1,2,3].map(n=>({attributes:{address:`pool-${n}`},relationships:{base_token:{data:{id:`solana_${mint}`}},quote_token:{data:{id:`solana_${usdc}`}}}}))});
  if(String(url).includes("pool-3"))return Response.json({error:"limit"},{status:429});
  const close=String(url).includes("pool-1")?2:2.2;return Response.json({data:{attributes:{ohlcv_list:[[120,close,close,close,close,1],[180,99,99,99,99,1]]}}});
 });
 const requests=[{signature:"event",mint,time:195},{signature:"cached-event",mint,time:195},{signature:"identity",mint:usdc,time:195}];
 const result=await liveReferenceMarks(requests,fetcher as typeof fetch,new AbortController().signal);
 expect(result.marks[`event:${mint}`]).toMatchObject({lower:"2",upper:"2.2",ageSeconds:15,kind:"reference-mark"});expect(result.marks[`cached-event:${mint}`]).toMatchObject({lower:"2",upper:"2.2"});expect(result.marks[`identity:${usdc}`]?.source).toContain("not USD peg");expect(fetcher).toHaveBeenCalledTimes(4);expect(result.attempts.some(a=>a.detail.includes("429"))).toBe(true);
});
