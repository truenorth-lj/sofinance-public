import { expect,it,vi } from "vitest";
vi.mock("server-only",()=>({}));
const exit=vi.hoisted(()=>vi.fn());
vi.mock("@/lib/lp-exit-data",()=>({readFullExitPreview:exit}));
import { GET as exitGET } from "./exit-preview/route";
import { GET as ledgerGET } from "./ledger/route";
const nft="DemoPosition1111111111111111111111111111111";
it("validates read-only exit input, forwards cancellation and preserves no-send failure",async()=>{
 const bad=await exitGET(new Request("http://local?positionId=bad"));expect(bad.status).toBe(400);expect(exit).not.toHaveBeenCalled();
 exit.mockResolvedValueOnce({status:"unavailable",reason:"packet limit",netRecoveryUSDC:null,executable:false,sent:false});const request=new Request(`http://local?positionId=${nft}&convertRent=0`),response=await exitGET(request);
 expect(exit).toHaveBeenLastCalledWith(nft,undefined,false,fetch,request.signal);expect(response.headers.get("Cache-Control")).toBe("no-store");expect(await response.json()).toMatchObject({netRecoveryUSDC:null,sent:false});
 exit.mockRejectedValueOnce(new Error('429 Too Many Requests: {"error":{"code":429}} https://rpc.example/private-key'));const failed=await exitGET(new Request(`http://local?positionId=${nft}`));expect(failed.status).toBe(503);const failure=await failed.json();expect(failure).toMatchObject({executable:false,sent:false,netRecoveryUSDC:null});expect(failure.error).toContain("data service is busy (rate limit)");expect(failure.error).toContain("No transaction was sent");expect(failure.error).not.toMatch(/private-key|jsonrpc|429/);
});
it("refuses a malformed cursor and a position without captured evidence",async()=>{
 expect((await ledgerGET(new Request(`http://local?positionId=${nft}&before=bad`))).status).toBe(400);
 expect((await ledgerGET(new Request("http://local?positionId=11111111111111111111111111111111&source=captured-public"))).status).toBe(503);
});
