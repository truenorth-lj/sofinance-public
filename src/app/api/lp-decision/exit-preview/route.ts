import { readFullExitPreview } from "@/lib/lp-exit-data";
import { sanitizePublicError } from "@/lib/public-error";
import { RPC_UNAVAILABLE_MESSAGE } from "@/lib/rpc/errors";
export const dynamic="force-dynamic";
export async function GET(request:Request){
 const url=new URL(request.url),positionId=url.searchParams.get("positionId")??"",nftAccount=url.searchParams.get("nftAccount")??undefined,convertRent=url.searchParams.get("convertRent")!=="0";
 if(!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(positionId)||(nftAccount&&!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(nftAccount)))return Response.json({error:"Invalid position/NFT account"},{status:400});
 try{return Response.json(await readFullExitPreview(positionId,nftAccount,convertRent,fetch,request.signal),{headers:{"Cache-Control":"no-store"}});}
 catch(e){return Response.json({status:"unavailable",netRecoveryUSDC:null,executable:false,sent:false,error:sanitizePublicError(e,RPC_UNAVAILABLE_MESSAGE)},{status:503,headers:{"Cache-Control":"no-store"}});}
}
