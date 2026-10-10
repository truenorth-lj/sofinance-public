"use client";
import { LpPositionEvidence } from "./lp-position-evidence";
import { useState } from "react";
import { amountToAtomic } from "@/lib/lp-decision";
import { useLpDecisionController } from "./use-lp-decision-controller";
import { LpDecisionResults } from "./lp-decision-results";
type Props = { poolId?: string; positionId?: string; contextLabel?: string; wallet?: string };
export function LpDecisionBuilder(props: Props) {
  const [date, setDate] = useState(""); const [amount, setAmount] = useState(""); const [demo, setDemo] = useState(false);
  return <Builder date={date} setDate={setDate} amount={amount} setAmount={setAmount} demo={demo} setDemo={setDemo} key={`${props.poolId}:${props.positionId}:${props.wallet}`} {...props} />;
}
type Inputs = { date: string; setDate: (value: string) => void; amount: string; setAmount: (value: string) => void; demo: boolean; setDemo: (value: boolean) => void };
function Builder({ poolId, positionId, contextLabel, date, setDate, amount, setAmount, demo, setDemo }: Props & Inputs) {
  const [validation, setValidation] = useState<string | null>(null);
  const [evidenceRevision,setEvidenceRevision]=useState(0);
  const controller = useLpDecisionController();
  const invalidate = () => { controller.cancel(); setValidation(null); setEvidenceRevision(v=>v+1); };
  return <section id="lp-decision" aria-label="LP 唯讀決策試算" className="my-8 rounded-[28px] border border-neutral-700 bg-[#0a0a0a] p-6 sm:p-9">
    <p className="mb-5 text-xs uppercase tracking-widest text-neutral-400">LP 唯讀分析</p>
    <form onSubmit={e => { e.preventDefault(); try { const amountAtomic = amountToAtomic(amount); setValidation(null); void controller.run({ poolId, positionId, amountAtomic, targetDate: date, demo, asset: "USDC", decimals: 6, numeraire: "USDC" }); } catch(e) { setValidation(e instanceof Error ? e.message : "輸入錯誤"); } }}>
      <div className="flex flex-wrap items-center gap-3 text-2xl font-semibold leading-relaxed sm:text-3xl">
        <span>我預計在</span><input aria-label="預期獲利了結時間" type="date" required value={date} onChange={e => { invalidate(); setDate(e.target.value); }} className="max-w-full rounded-xl bg-neutral-900 p-3 text-sky-300 [color-scheme:dark]" />
        <span>獲利了結，投入</span><input aria-label="投入金額" required inputMode="decimal" placeholder="金額" value={amount} onChange={e => { invalidate(); setAmount(e.target.value); }} className="w-40 rounded-xl bg-neutral-900 p-3 text-sky-300" /><span>USDC</span>
      </div>
      <p className="mt-4 text-xs text-neutral-400">目標為所選日期 UTC 00:00（未來 365 天內），按實際剩餘小時試算；不是保證獲利日。第一版分析輸入支援 USDC，其他資產仍可在既有交易流程使用。</p>
      <p className="mt-3 break-all text-xs text-neutral-400">{contextLabel ? `帶入來源：${contextLabel} · ${positionId ?? poolId}` : "未選池／持倉；可從下方持倉或 RWA 池頁帶入。正式資料尚不足，選池也不會產生虛構結果。"} · 金額由你輸入，不自動套用錢包餘額。</p>
      {!poolId && !positionId && <a href="/app/rwa-pairs#lp-decision" className="mt-3 inline-block text-sm text-sky-300">下一步：選擇 RWA 池以讀取真實資料</a>}
      <label className="mt-5 flex items-center gap-2 text-xs text-neutral-400"><input type="checkbox" checked={demo} onChange={e => { invalidate(); setDemo(e.target.checked); }} />使用 DEMO 合成情境（非真實資料，不可交易）</label>
      <div className="mt-5 flex gap-4"><button type="submit" disabled={controller.busy} className="rounded-xl bg-neutral-100 px-6 py-3 text-sm font-semibold text-neutral-950 disabled:opacity-40">{controller.busy ? "試算中…" : "查看試算"}</button><button type="button" onClick={invalidate} className="text-sm text-neutral-400">返回／取消</button></div>
    </form>
    {(validation || controller.error) && <p role="alert" className="mt-4 text-amber-200">{validation || controller.error}</p>}
    {!demo&&positionId&&<LpPositionEvidence key={`${positionId}:${date}:${amount}:${evidenceRevision}`} positionId={positionId}/>}
    {controller.result && <><p className="mt-6 text-sm text-neutral-400">評估期間：現在至 {date}（UTC） · 投入 {amount} USDC</p><LpDecisionResults result={controller.result} /></>}
  </section>;
}
