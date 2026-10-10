import { readPositionFlowAudit } from "@/lib/lp-flow-data";
import { sanitizePublicError } from "@/lib/public-error";
import { RPC_UNAVAILABLE_MESSAGE } from "@/lib/rpc/errors";
export const dynamic="force-dynamic";
export async function GET(request:Request){
  const url=new URL(request.url),positionId=url.searchParams.get("positionId")??"",source=url.searchParams.get("source")??"live",before=url.searchParams.get("before")??undefined;
  if(!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(positionId)||!["live","captured-public"].includes(source)||(before&&!/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(before)))return Response.json({error:"Invalid position/source/cursor"},{status:400});
  try{return Response.json(await readPositionFlowAudit(positionId,source as "live"|"captured-public",before,fetch,request.signal,url.searchParams.get("analyze")==="1"),{headers:{"Cache-Control":"no-store"}});}
  catch(e){return Response.json({status:"unavailable",source,netUSDC:null,completeWalletAccounting:false,error:sanitizePublicError(e,RPC_UNAVAILABLE_MESSAGE)},{status:503,headers:{"Cache-Control":"no-store"}});}
}
