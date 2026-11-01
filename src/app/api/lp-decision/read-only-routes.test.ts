import { expect,it,vi } from "vitest";
vi.mock("server-only",()=>({}));
const exit=vi.hoisted(()=>vi.fn());
vi.mock("@sofinance/engine/lp-exit-data",()=>({readFullExitPreview:exit}));
import { JupiterHttpError, JUPITER_UNAVAILABLE_CODE, JUPITER_UNAVAILABLE_MESSAGE } from "@sofinance/engine/jupiter/errors";
const capture=vi.hoisted(()=>vi.fn());
vi.mock("@/lib/sentry/capture",async(importOriginal)=>({...(await importOriginal<Record<string,unknown>>()),captureApiRouteError:capture}));
import { GET as exitGET } from "./exit-preview/route";
import { directUsdcExitPreview, EXIT_PREVIEW_DIRECT_USDC_MESSAGE } from "@sofinance/engine/exit-preview-support";
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
it("answers a direct-USDC pool with a typed 200 'unsupported' result, never 503 and never Sentry",async()=>{
 capture.mockClear();
 exit.mockResolvedValueOnce(directUsdcExitPreview());
 const response=await exitGET(new Request(`http://local?positionId=${nft}&convertRent=0`));
 expect(response.status).toBe(200);
 expect(await response.json()).toEqual({status:"unsupported",reason:"direct_usdc",message:EXIT_PREVIEW_DIRECT_USDC_MESSAGE,netRecoveryUSDC:null,executable:false,sent:false});
 expect(capture).not.toHaveBeenCalled();
});
it("still reports a real failure as 503 and to Sentry",async()=>{
 vi.spyOn(console,"info").mockImplementation(()=>undefined);capture.mockClear();
 exit.mockRejectedValueOnce(new Error("Combined exit simulation failed: {}"));
 const failed=await exitGET(new Request(`http://local?positionId=${nft}`));
 expect(failed.status).toBe(503);expect(capture).toHaveBeenCalledTimes(1);
});
