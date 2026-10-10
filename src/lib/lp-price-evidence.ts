/** A historical mark is an observation, never an exact event-time price. */
export function priorMinuteMark(eventTimeSeconds:number,bars:number[][],maxAgeSeconds=60){
  if(!Number.isSafeInteger(eventTimeSeconds)||eventTimeSeconds<=0)return {status:"unavailable" as const,reason:"Invalid event timestamp",priceUSDC:null};
  const prior=bars.filter(b=>b.length===6&&b.every(Number.isFinite)&&b[0]!+60<=eventTimeSeconds&&b[4]!>0).sort((a,b)=>b[0]!-a[0]!)[0];
  if(!prior||eventTimeSeconds-(prior[0]!+60)>maxAgeSeconds)return {status:"unavailable" as const,reason:"No completed prior minute candle within age limit",priceUSDC:null};
  return {status:"reference-mark" as const,priceUSDC:String(prior[4]),sourceStart:new Date(prior[0]!*1000).toISOString(),sourceEnd:new Date((prior[0]!+60)*1000).toISOString(),ageSeconds:eventTimeSeconds-prior[0]!-60,exactEventTimePrice:false as const};
}
