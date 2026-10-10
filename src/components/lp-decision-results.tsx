"use client";
import Decimal from "decimal.js";
import type { DecisionResponse, Metric } from "@/lib/lp-decision";
const displayNumber = (v: string | number) => new Decimal(v).toDecimalPlaces(4).toString();
const metric = (m: Metric) => m.value === null ? `unavailable：${m.reasons.join("；")}` : `${new Decimal(m.value).toFixed(4)} USDC`;
export function LpDecisionResults({ result }: { result: DecisionResponse }) {
  const label = (s: string) => result.mode === "new" ? ({hold: "進場維持", rerange: "條件式重掛", exit: "暫不投入"}[s]) : ({hold: "維持", rerange: "重掛", exit: "退出"}[s]);
  return <div role="status" className="mt-6 space-y-4 text-sm text-neutral-300">
    <p className="text-xl font-semibold">{result.demo ? "DEMO 情境試算" : result.status === "partial" ? "已讀取真實公開資料，完整淨結果仍缺對帳" : "資料不足，無法可靠估計淨結果"}</p>
    <p>計價 USDC · 截至 {result.asOf} · {result.mode === "new" ? "新倉尚未投入" : "現有持倉從現在起比較"} · 無已驗證機率</p>
    {result.warnings.map(w => <p key={w} className="text-amber-200">{w}</p>)}
    <details><summary className="cursor-pointer">歷史、HODL、退出及資料來源</summary>
      <p>歷史絕對淨損益：{metric(result.historical)}</p><p>相同資金流 HODL 超額淨損益：{metric(result.hodlExcess)}</p><p>可報價退出淨回收：{metric(result.exit)}</p>
      {result.sources.map(s => <p key={s.source}>{s.status} · {s.source} · {s.asOf}</p>)}
      <p>口徑版本 {result.version}</p><p>機率門檻：{result.probabilityGate.join("；")}</p>
    </details>
    {result.observations && <details open className="rounded-2xl border border-neutral-700 p-4"><summary>真實唯讀觀測（不是淨收益／可交易報價）</summary>
      {result.observations.pool && <p className="mt-2 break-all">池 {result.observations.pool.id} · B/A 中間價 {result.observations.pool.priceBPerA} · 費率 {result.observations.pool.feeRate} · 取得於 {result.observations.pool.fetchedAt}</p>}
      {result.observations.position && <p>公開持倉 {result.observations.position.positionId} · 已讀交易 {result.observations.position.transactionsRead} · 歷史窗口 {result.observations.position.signatureWindowComplete ? "此窗口未截斷，仍缺歸屬與餘額對帳" : "截斷／部分"} · 相關交易 network+priority 總費（未歸屬／分攤到此 LP） {result.observations.position.networkAndPriorityLamports} lamports（未轉 USDC，未分拆）</p>}
      {result.observations.market && <p>真實 USD 日線 {result.observations.market.bars.length} 筆 · 取得於 {result.observations.market.fetchedAt}；日線不是事件當時 USDC 價格，不用於完整歷史損益。</p>}
      {result.observations.exitPrincipal && <details className="mt-3"><summary>唯讀退出本金／獨立兌換報價（完整退出淨回收 unavailable）</summary>
        <p>本金原子量 A {result.observations.exitPrincipal.amountAAtomic} / B {result.observations.exitPrincipal.amountBAtomic} · 取得於 {result.observations.exitPrincipal.fetchedAt}</p>
        {result.observations.exitPrincipal.quotes.map(q=><p key={q.mint} className="break-all text-xs">mint {q.mint} · input {q.inputAtomic} · out {q.outputUSDCAtomic} USDC 原子量（6 位） · threshold {q.thresholdUSDCAtomic} · slot {q.contextSlot ?? "未知"} · {q.observedAt} · 無來源有效期限，須重新報價；未合併模擬／扣完整成本。</p>)}
        <p>缺口：{result.observations.exitPrincipal.missing.join("；")}</p>
      </details>}
      <details className="mt-3"><summary>獎勵／转帳費／餘額／租金原始證據（未歸屬）</summary>
        {result.observations.transactionEvidence.map(e=><div key={e.signature} className="mt-2 break-all text-xs"><p>{e.signature} · liquidity delta {e.liquidityDelta}</p>
          {e.rewardSlots.map(r=><p key={`${r.logIndex}:${r.slot}`}>reward slot {r.slot} · 原子量 {r.amountAtomic} · mint {r.mint ?? "未核對"} · {r.matchedBalance ? "同交易唯一轉帳及雙方餘額吻合；後續是否複投仍未分類" : "未完成餘額映射"}</p>)}
          {e.transferFees.map(f=><p key={`${f.logIndex}:${f.mint}`}>轉帳費 {f.amountAtomic} 原子量 · mint {f.mint}（未換 USDC／未重扣）</p>)}
          <p>交易 token 餘額 {e.tokenBalances.length} 筆；租金相關指令 {e.rentInstructions.length} 筆。账户 delta 包含同交易其他操作，不直接當作 LP 收入或退款。</p>
        </div>)}
      </details>
      <p>原始事件 {result.observations.ledger.length} 筆；沒有用現在價格回填歷史。</p>
      {result.observations.attempts.map((a,i) => <p key={i} className="mt-2 text-xs">{a.status} · {a.source} · {a.detail}</p>)}
      <details className="mt-3"><summary>原子單位事件台帳（歸屬尚未分類）</summary>{result.observations.ledger.map(e => <p key={e.id} className="mt-2 break-all text-xs">{e.timestamp ?? "未知時間"} · {e.kind} · {e.amountAtomic} 原子量 / decimals {e.decimals} · mint {e.mint} · signature {e.signature} · log {e.eventIndex}</p>)}</details>
    </details>}
    {result.scenarios.map(s => <details key={s.id} className="rounded-2xl border border-neutral-700 p-4">
      <summary className="cursor-pointer font-semibold">{s.label} · {label("hold")}增量淨結果 {metric(s.strategies[0]!.net)}</summary>
      <p className="my-3">DEMO 假設 · {s.assumptions.source} · 試算到第 {displayNumber(s.assumptions.path.at(-1)?.day ?? 0)} 天；最重要假設：費用只依取樣點是否在區間內累計，未聲稱連續路徑。所有金額為此指定路徑的單點結果，未估計統計區間。</p>
      {s.strategies.map(row => <div key={row.strategy} className="my-3 rounded-xl bg-neutral-900 p-3">
        <p>{label(row.strategy)}：扣成本增量淨損益 {metric(row.net)}</p>
        {row.strategy === "rerange" && <p className="font-semibold">重掛扣成本後比維持多／少 {metric(row.deltaVsHold)}</p>}
        <p>{row.strategy === "exit" && result.mode === "new" ? "尚未投入，沒有回本期" : `條件式至少持有：${row.breakevenDay === null ? row.breakevenReason : `第 ${displayNumber(row.breakevenDay)} 天（取樣點）；${row.breakevenReason}`}`}</p>
        {row.rebalances.map((event,i) => <p key={i}>第 {displayNumber(event.day)} 天觸發重掛 · 新區間 [{event.lower}, {event.upper}] · 從本金扣 {event.cost} USDC（不重扣）</p>)}
        <p>增量成本（包含進場／持有／操作／退出路徑的 demo 總成本；無歷史沉沒成本）：</p>
        {s.assumptions.costs[row.strategy].map(c => <span className="mr-3 inline-block text-xs" key={c.id}>{c.category} {c.value ?? "未知"} · {c.included ? "已內含" : "另扣"}</span>)}
      </div>)}
      <p>條件重掛：價格離開當時區間後才觸發；冷卻 {s.assumptions.rerangePolicy?.cooldownDays} 天，最多 {s.assumptions.rerangePolicy?.maxRebalances} 次；費用先依舊區間估，再扣本次重掛成本並以剩餘本金重設。</p>
      <p>費率 {s.assumptions.feeRate} · 維持區間 [{s.assumptions.lower}, {s.assumptions.upper}] · 重掛上下界 = 觸發價格 × [{s.assumptions.rerangePolicy?.lowerFactor}, {s.assumptions.rerangePolicy?.upperFactor}]</p>
      <table className="mt-3 w-full text-left text-xs"><thead><tr><th>天</th><th>價格 B/A</th><th>成交量 B</th><th>Active liquidity</th></tr></thead><tbody>{s.assumptions.path.map(p => <tr key={p.day}><td>{displayNumber(p.day)}</td><td>{displayNumber(p.priceBPerA)}</td><td>{displayNumber(p.volumeB)}</td><td>{displayNumber(p.activeLiquidity)}</td></tr>)}</tbody></table>
      <p className="mt-3">重掛為指定取樣點的決定性條件策略，未執行交易或訓練預測。持倉份額以 L / (active L + L) 計算；USDC 為計價單位；退出 LP 保留原代幣仍承擔價格曝險。此 demo 退出是假設換成 USDC 的成本示意，沒有可成交報價。</p>
    </details>)}
  </div>;
}
