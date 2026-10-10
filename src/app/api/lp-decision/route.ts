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
      result.warnings.push("Public observations retrieved. Historical USDC valuation, income attribution and full reconciliation are incomplete. Raw events do not necessarily represent attributable external income.");
    }
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: "Invalid input, or the target date is outside the next 1–365 days (UTC)." }, { status: 400 });
  }
}
