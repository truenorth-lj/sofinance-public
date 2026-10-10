import { readDecisionObservations } from "@/lib/lp-decision-data";
import { buildDecision, decisionRequestSchema } from "@/lib/lp-decision";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  try {
    const text = await request.text();
    if (text.length > 4096) return Response.json({ error: "Request too large" }, { status: 413 });
    const parsed = decisionRequestSchema.safeParse(JSON.parse(text));
    if (!parsed.success) return Response.json({ error: "Invalid decision input" }, { status: 400 });
    const result = buildDecision(parsed.data);
    if (!parsed.data.demo && (parsed.data.poolId || parsed.data.positionId)) {
      result.observations = await readDecisionObservations(parsed.data, fetch, request.signal);
      if (result.observations.pool || result.observations.position) result.status = "partial";
      result.sources = result.observations.attempts.map(a => ({source: `${a.source}: ${a.detail}`,asOf:a.observedAt,status:a.status === "error" ? "missing" as const : "fresh" as const}));
      result.warnings.push("已讀取真實公開觀測；尚未完成歷史 USDC 估值、收益歸屬與完整對帳。原始事件不等於可計入的外部收益。");
    }
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: "輸入格式錯誤，或日期不在未來 1–365 天內（UTC）" }, { status: 400 });
  }
}
