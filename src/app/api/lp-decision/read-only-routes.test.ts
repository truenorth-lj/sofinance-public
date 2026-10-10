import { expect,it,vi } from "vitest";
vi.mock("server-only",()=>({}));
const exit=vi.hoisted(()=>vi.fn());
vi.mock("@/lib/lp-exit-data",()=>({readFullExitPreview:exit}));
import { JupiterHttpError, JUPITER_UNAVAILABLE_CODE, JUPITER_UNAVAILABLE_MESSAGE } from "@/lib/jupiter/errors";
import { GET as exitGET } from "./exit-preview/route";
import { GET as ledgerGET } from "./ledger/route";
const nft="DemoPosition1111111111111111111111111111111";
it("validates read-only exit input, forwards cancellation and preserves no-send failure",async()=>{
 const logged=vi.spyOn(console,"info").mockImplementation(()=>undefined);
 const bad=await exitGET(new Request("http://local?positionId=bad"));expect(bad.status).toBe(400);expect(exit).not.toHaveBeenCalled();
 exit.mockResolvedValueOnce({status:"unavailable",reason:"packet limit",netRecoveryUSDC:null,executable:false,sent:false});const request=new Request(`http://local?positionId=${nft}&convertRent=0`),response=await exitGET(request);
 expect(exit).toHaveBeenLastCalledWith(nft,undefined,false,fetch,request.signal);expect(response.headers.get("Cache-Control")).toBe("no-store");expect(await response.json()).toMatchObject({netRecoveryUSDC:null,sent:false});
 exit.mockRejectedValueOnce(new Error("429 Too Many Requests: Too many requests for a specific RPC call"));const failed=await exitGET(new Request(`http://local?positionId=${nft}`));expect(failed.status).toBe(503);expect(await failed.json()).toMatchObject({executable:false,sent:false,netRecoveryUSDC:null,error:"Solana RPC is temporarily unavailable. Please retry in a moment.",errorCode:"rpc_unavailable"});
 expect(String(logged.mock.calls.at(-1)?.[0])).toContain("\"exitPreview\":true");
 expect(String(logged.mock.calls.at(-1)?.[0])).not.toMatch(/api[_-]?key|https?:\/\//i);
});
it("returns a distinct Jupiter error code instead of the Solana RPC text",async()=>{
 const logged=vi.spyOn(console,"info").mockImplementation(()=>undefined);
 exit.mockRejectedValueOnce(new JupiterHttpError(429,"/swap/v1/quote"));
 const failed=await exitGET(new Request(`http://local?positionId=${nft}`));
 expect(failed.status).toBe(503);
 expect(await failed.json()).toMatchObject({executable:false,sent:false,netRecoveryUSDC:null,error:JUPITER_UNAVAILABLE_MESSAGE,errorCode:JUPITER_UNAVAILABLE_CODE});
 const line=String(logged.mock.calls.at(-1)?.[0]);
 expect(line).toContain("\"exitPreview\":true");
 expect(line).toContain("JupiterHttpError");
 expect(line).toContain("Jupiter HTTP 429");
 expect(line).not.toMatch(/secret|api[_-]?key/i);
});
it("refuses a malformed cursor and a position without captured evidence",async()=>{
 expect((await ledgerGET(new Request(`http://local?positionId=${nft}&before=bad`))).status).toBe(400);
 expect((await ledgerGET(new Request("http://local?positionId=11111111111111111111111111111111&source=captured-public"))).status).toBe(503);
});
