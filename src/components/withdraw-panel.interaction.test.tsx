// @vitest-environment happy-dom
import {act,createElement} from "react";
import {createRoot,type Root} from "react-dom/client";
import {afterEach,beforeEach,expect,it,vi} from "vitest";
import {WithdrawPanel} from "./withdraw-panel";
import {USDC_MINT} from "../lib/ids";
const mocks=vi.hoisted(()=>({sign:vi.fn(),historyChange:vi.fn()}));
vi.mock("./wallet-connection",()=>({useWalletConnection:()=>({address:"wallet",signTransaction:mocks.sign})}));
vi.mock("@/lib/position-history-refresh",()=>({notifyPositionHistoryChange:mocks.historyChange}));
let root:Root,container:HTMLDivElement;
beforeEach(()=>{
 localStorage.clear();mocks.sign.mockReset();mocks.historyChange.mockReset();
 container=document.createElement("div");document.body.append(container);root=createRoot(container);
 (globalThis as unknown as Record<string,unknown>).IS_REACT_ACT_ENVIRONMENT=true;
 vi.spyOn(HTMLDialogElement.prototype,"showModal").mockImplementation(function(this:HTMLDialogElement){this.setAttribute("open","");});
 vi.spyOn(HTMLDialogElement.prototype,"close").mockImplementation(function(this:HTMLDialogElement){this.removeAttribute("open");});
});

function checkpoint(stage:"atomic"|"withdraw"|"swap"){
 localStorage.setItem("sofinance:withdraw:wallet:position",JSON.stringify({
  signature:"verified-withdraw-signature",request:{wallet:"wallet",positionMint:"position",percent:50,receive:"usdc"},confirmHighImpact:false,
  prepared:{summary:{positionMint:"position",stage,requiresSecondConfirmation:false},permit:"permit",unsignedTransaction:"unused"},
 }));
}
it("marks an already-finalized first withdrawal dirty even if preparing its conversion fails",async()=>{
 checkpoint("withdraw");
 const fetcher=vi.fn(async(path:string)=>path==="/api/withdraw-status"?Response.json({status:"success"}):Response.json({error:"Conversion unavailable"},{status:503}));
 vi.stubGlobal("fetch",fetcher);await render();await click("Resume withdrawal");
 expect(mocks.historyChange).toHaveBeenCalledWith("position","verified-withdraw-signature");
 expect(container.textContent).toContain("Conversion unavailable");expect(mocks.sign).not.toHaveBeenCalled();
});
it("uses a force-only refresh for the finalized conversion rather than waiting for its signature in position history",async()=>{
 checkpoint("swap");vi.stubGlobal("fetch",vi.fn(async()=>Response.json({status:"success"})));
 await render();await click("Resume withdrawal");
 expect(mocks.historyChange).toHaveBeenCalledWith("position",undefined);
 expect(container.textContent).toContain("Withdrawal complete");expect(mocks.sign).not.toHaveBeenCalled();
});
it.each(["manual-review","failed","expired"])("does not notify history for withdrawal status %s",async(status)=>{
 checkpoint("atomic");vi.stubGlobal("fetch",vi.fn(async()=>Response.json({status})));
 await render();await click("Resume withdrawal");
 expect(mocks.historyChange).not.toHaveBeenCalled();expect(container.textContent).toContain(status);
});
it("Withdraw without a preview fetches one and shows loading, then a visible error",async()=>{
 let resolve:(r:Response)=>void=()=>{};
 const fetcher=vi.fn(()=>new Promise<Response>(r=>{resolve=r;}));vi.stubGlobal("fetch",fetcher);
 await render();await click("Withdraw");
 expect(fetcher).toHaveBeenCalledWith("/api/withdraw-quote",expect.anything());
 expect(container.textContent).toContain("Calculating preview");
 expect(Array.from(container.querySelectorAll("button")).some(b=>b.textContent==="Calculating…"&&b.disabled)).toBe(true);
 await act(async()=>resolve(Response.json({error:"Withdrawal preview failed"},{status:400})));
 expect(container.querySelector('[role="alert"]')?.textContent).toBe("Withdrawal preview failed");
 expect(mocks.sign).not.toHaveBeenCalled();
});
it("shows a readable error when the server returns a non-JSON page",async()=>{
 vi.stubGlobal("fetch",vi.fn(async()=>new Response("<html>504</html>",{status:504})));
 await render();await click("Preview");
 expect(container.querySelector('[role="alert"]')?.textContent).toContain("Server error (504)");
});
it("rejects an invalid target amount with a message instead of a silent request",async()=>{
 const fetcher=vi.fn();vi.stubGlobal("fetch",fetcher);await render();
 const input=container.querySelector<HTMLInputElement>('input[aria-label="Target USDC estimate"]')!;
 await act(async()=>{const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!;set.call(input,"0");input.dispatchEvent(new Event("input",{bubbles:true}));});
 await click("Preview");
 expect(fetcher).not.toHaveBeenCalled();expect(container.textContent).toContain("Enter a USDC amount above 0");
});
afterEach(async()=>{await act(async()=>root.unmount());container.remove();vi.restoreAllMocks();vi.unstubAllGlobals();});
async function render(){await act(async()=>root.render(createElement(WithdrawPanel,{wallet:"wallet",positionMint:"position",mintA:"mint-a",mintB:"mint-b",label:(mint:string)=>mint===USDC_MINT?"USDC":mint,onClose:vi.fn(),onConfirmed:vi.fn(),onBusyChange:vi.fn()})));}
async function click(text:string){const button=Array.from(container.querySelectorAll("button")).find(b=>b.textContent===text)!;await act(async()=>button.click());}
it("previews USDC by default and asks for second confirmation before preparing high impact",async()=>{
 const fetcher=vi.fn(async()=>Response.json({percentBps:10000,receive:"usdc",outputs:[{mint:USDC_MINT,minimum:"990000",expected:"1000000",decimals:6}],priceImpactBps:600,warning:true,requiresSecondConfirmation:true,slippageBps:50,protocolFee:{bps:10,legs:[{mint:USDC_MINT,amount:"1000"}]},rentRefundLamports:"2039280",assets:[],transactions:2}));
 vi.stubGlobal("fetch",fetcher);await render();await click("Preview");
 expect(fetcher).toHaveBeenCalledWith("/api/withdraw-quote",expect.objectContaining({body:JSON.stringify({wallet:"wallet",positionMint:"position",percent:100,receive:"usdc"})}));
 expect(container.textContent).toContain("Minimum received: 0.99 USDC");expect(container.textContent).toContain("Two steps");expect(container.textContent).toContain("Fee estimate: 0.001 USDC");
 await click("Withdraw");expect(container.querySelector("dialog")?.open).toBe(true);
 expect(fetcher).toHaveBeenCalledOnce();expect(mocks.sign).not.toHaveBeenCalled();
 await click("Cancel");expect(container.querySelector("dialog")?.open).toBe(false);
});
