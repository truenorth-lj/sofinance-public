import { opensDailyUnauthorizedStatus, opensDailyCsv, queryOpensDaily } from "@/lib/opens-log";

export const runtime = "nodejs";

function parseDays(value: string | null) {
  if (!value) return 90;
  const days = Number(value);
  if (!Number.isInteger(days) || days < 1 || days > 366) return 90;
  return days;
}

export async function GET(request: Request) {
  const denied = opensDailyUnauthorizedStatus(request.headers.get("authorization"));
  if (denied) {
    return new Response(denied === 404 ? undefined : JSON.stringify({ error: "Unauthorized" }), {
      status: denied,
      headers: { "Cache-Control": "no-store", ...(denied === 401 ? { "Content-Type": "application/json" } : {}) },
    });
  }
  try {
    const url = new URL(request.url);
    const result = await queryOpensDaily({ days: parseDays(url.searchParams.get("days")) });
    const csv = url.searchParams.get("format") === "csv";
    if (csv) {
      return new Response(opensDailyCsv(result.days), {
        status: 200,
        headers: {
          "Cache-Control": "no-store",
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": "attachment; filename=opens-daily.csv",
        },
      });
    }
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: "Opens log temporarily unavailable" }, {
      status: 503,
      headers: { "Cache-Control": "no-store" },
    });
  }
}
