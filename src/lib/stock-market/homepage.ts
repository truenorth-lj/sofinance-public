import "@/lib/engine-host";
import "server-only";
import { withTimeout as withTimeoutMs } from "@sofinance/engine/async";
import { loadStockBuyEligibility, loadStockMarket } from "./source";
import { toHomepageStocks, type HomepageStocks } from "./public";

/** Give up on the market read after this long; the cards then load on the client from `/api/stock-market`. */
const TIMEOUT_MS = 8_000;
/**
 * A cold eligibility read probes each displayed stock's route one Jupiter call at a time (>= 1.1 s apart, 1 req/s
 * free tier), so it needs longer than the market read. Runs at build / ISR regeneration, not while a visitor waits.
 */
const ELIGIBILITY_TIMEOUT_MS = 30_000;

const withTimeout = <T>(promise: Promise<T>, ms = TIMEOUT_MS) => withTimeoutMs(promise, ms, { message: "stock data timeout" });

/**
 * Cards data for the homepage HTML. Null when the market read fails (cards then load on the client). A failed or
 * slow eligibility read only removes the Buy buttons (fail closed); the cards still render.
 */
export async function loadHomepageStocks(ms = TIMEOUT_MS, eligibilityMs = ELIGIBILITY_TIMEOUT_MS): Promise<HomepageStocks | null> {
  const market = await withTimeout(loadStockMarket(), ms).catch(() => null);
  if (!market) return null;
  const eligibility = await withTimeout(loadStockBuyEligibility(market), eligibilityMs).catch(() => null);
  return toHomepageStocks(market, eligibility);
}
