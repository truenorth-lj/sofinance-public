import "@/lib/engine-host";
import { loadHomepageStocks } from "@/lib/stock-market/homepage";
import { NO_STORE_HEADERS } from "@/lib/http/no-store";

/**
 * Homepage Top Gainers / Top Stocks (client fallback when the page HTML had none). Rendered per request from the server
 * cache (Jupiter search, 10 minutes) and CDN-cached 5 minutes; dynamic so a failed build-time read is never baked in.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  const stocks = await loadHomepageStocks(20_000);
  if (!stocks) {
    return Response.json({ error: "Stock data is temporarily unavailable." }, { status: 503, headers: NO_STORE_HEADERS });
  }
  return Response.json(stocks, { headers: { "Cache-Control": "public, s-maxage=300, stale-while-revalidate=600" } });
}
