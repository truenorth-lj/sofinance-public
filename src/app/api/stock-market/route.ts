import "@/lib/engine-host";
import { loadHomepageStocks } from "@/lib/stock-market/homepage";

/** Homepage Top Gainers / Top Stocks (client fallback when the page HTML had none). Served from the server cache. */
export const revalidate = 600;

export async function GET() {
  const stocks = await loadHomepageStocks(20_000);
  if (!stocks) {
    return Response.json({ error: "Stock data is temporarily unavailable." }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
  return Response.json(stocks, { headers: { "Cache-Control": "public, s-maxage=300, stale-while-revalidate=600" } });
}
