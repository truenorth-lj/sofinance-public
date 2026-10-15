import "@/lib/engine-host";
import { getJupiterApiKey } from "@sofinance/engine/config/server-env";
import { NATIVE_SOL_MINT, USDC_MINT } from "@sofinance/engine/ids";
import { fetchJupiterPricesUsd } from "@sofinance/engine/token-prices";

export async function GET() {
  const prices = await fetchJupiterPricesUsd([NATIVE_SOL_MINT, USDC_MINT], fetch, getJupiterApiKey());
  const sol = prices.get(NATIVE_SOL_MINT);
  const usdc = prices.get(USDC_MINT);
  const rate = sol !== undefined && usdc !== undefined && sol > 0 && usdc > 0 ? sol / usdc : null;
  return Response.json({
    rate: rate !== null && Number.isFinite(rate) && rate > 0 ? rate : null,
    usdcUsd: usdc !== undefined && Number.isFinite(usdc) && usdc > 0 ? usdc : null,
    fetchedAt: Date.now(),
    source: "Jupiter",
  }, { headers: { "Cache-Control": "no-store" } });
}
