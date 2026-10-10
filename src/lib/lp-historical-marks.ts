import "server-only";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { readdir,readFile } from "node:fs/promises";
import { priorMinuteMark } from "./lp-price-evidence";
const dir=join(process.cwd(),"specs/lp-decision/fixtures");
const read=async(name:string)=>JSON.parse(await readFile(join(dir,`${name}.json`),"utf8"));
/** Captured public marks remain reference observations; never enable exact-net metrics. */
export async function readCapturedHistoricalMarks(){
 const attempts=(await read("closure/historical-mark-attempts")).attempts;
 const audit=await read("public-position-flow-audit"),tokens=[["a","SPCXxcqXj6e5dJDVNovHN8744zkbhM2bYudU45BimGb"],["b","Xs3oZwbHvqis4NYcf4YKWmEia2eC84wSiVrcYcTqpH8"],["sol","So11111111111111111111111111111111111111112"],["ray","4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R"]] as const;
 const relatedSignature=(await readdir(join(dir,"closure"))).find(name=>name.startsWith("related-tx-"))?.slice("related-tx-".length,-".json".length);
 if(!relatedSignature)throw new Error("No captured public evidence is installed");
 const related=(await read(`closure/related-tx-${relatedSignature}`)).result;
 const rows=[];
 for(const row of [...audit.rows,{signature:relatedSignature,timestamp:new Date(related.blockTime*1000).toISOString(),rewards:[],rentRefund:true}]){if(!row.timestamp)continue;const time=Date.parse(row.timestamp)/1000,day=row.timestamp.slice(0,10);
  for(const [label,mint] of tokens){if(row.rentRefund&&label!=="sol")continue;if(label==="ray"&&!row.rewards.some((r:{amountAtomic:string})=>r.amountAtomic!=="0"))continue;
   let mark;try{const raw=await readFile(join(dir,`closure/marks/${label}-${day}.json`),"utf8"),hash=createHash("sha256").update(raw).digest("hex");
    const evidence=attempts.findLast((a:{label:string;day:string;sha256:string;httpStatus:number;denominator:string;mint:string})=>a.label===label&&a.day===day&&a.sha256===hash&&a.httpStatus===200&&a.mint===mint&&a.denominator==="EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");if(!evidence)throw new Error("No matching USDC provenance");
    const data=JSON.parse(raw);mark={...priorMinuteMark(time,data.data.attributes.ohlcv_list),sourceURL:evidence.url,sourceObservedAt:evidence.observedAt,sha256:hash};}catch{mark={status:"unavailable",reason:"Captured minute source missing",priceUSDC:null};}
   rows.push({signature:row.signature,timestamp:row.timestamp,mint,denominator:"USDC",source:"GeckoTerminal direct USDC pool minute close",...mark});
  }
 }
 return {synthetic:false,fresh:false,scope:"captured public benchmark position only",exactEventTimePrices:false,requiredMarks:rows.length,availableReferenceMarks:rows.filter(r=>r.status==="reference-mark").length,rows,netUSDC:null};
}
