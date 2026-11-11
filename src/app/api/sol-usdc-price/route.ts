import "@/lib/engine-host";
import { getJupiterApiKey } from "@sofinance/engine/config/server-env";
import { NATIVE_SOL_MINT, USDC_MINT } from "@sofinance/engine/ids";
import { fetchTokenPricesUsd, type TokenPriceSource } from "@sofinance/engine/token-prices";
import { NO_STORE_HEADERS } from "@/lib/http/no-store";

export async function GET() {
  const quotes = await fetchTokenPricesUsd([NATIVE_SOL_MINT, USDC_MINT], fetch, getJupiterApiKey());
  const sol = quotes.get(NATIVE_SOL_MINT);
  const usdc = quotes.get(USDC_MINT);
  const solUsd = sol?.price;
  const usdcUsd = usdc?.price;
  const rate = solUsd !== undefined && usdcUsd !== undefined && solUsd > 0 && usdcUsd > 0 ? solUsd / usdcUsd : null;
  const sources = [...new Set([sol?.source, usdc?.source].filter((item): item is TokenPriceSource => Boolean(item)))].sort();
  return Response.json({
    rate: rate !== null && Number.isFinite(rate) && rate > 0 ? rate : null,
    usdcUsd: usdcUsd !== undefined && Number.isFinite(usdcUsd) && usdcUsd > 0 ? usdcUsd : null,
    fetchedAt: Date.now(),
    source: sources.length ? sources.join("+") : "unavailable",
  }, { headers: NO_STORE_HEADERS });
}
