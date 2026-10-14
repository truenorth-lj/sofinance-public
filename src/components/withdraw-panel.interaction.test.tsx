// @vitest-environment happy-dom
import {act,createElement} from "react";
import {createRoot,type Root} from "react-dom/client";
import {afterEach,beforeEach,expect,it,vi} from "vitest";
import {WithdrawPanel} from "./withdraw-panel";
import {USDC_MINT} from "../lib/ids";
const mocks=vi.hoisted(()=>({sign:vi.fn()}));
vi.mock("./wallet-connection",()=>({useWalletConnection:()=>({address:"wallet",signTransaction:mocks.sign})}));
let root:Root,container:HTMLDivElement;
beforeEach(()=>{
 localStorage.clear();mocks.sign.mockReset();
 container=document.createElement("div");document.body.append(container);root=createRoot(container);
 (globalThis as unknown as Record<string,unknown>).IS_REACT_ACT_ENVIRONMENT=true;
 vi.spyOn(HTMLDialogElement.prototype,"showModal").mockImplementation(function(this:HTMLDialogElement){this.setAttribute("open","");});
 vi.spyOn(HTMLDialogElement.prototype,"close").mockImplementation(function(this:HTMLDialogElement){this.removeAttribute("open");});
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
