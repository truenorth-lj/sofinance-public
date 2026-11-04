import "server-only";
import { loadStockBuyEligibility, loadStockMarket } from "./source";
import { toHomepageStocks, type HomepageStocks } from "./public";

/** Give up after this long; the cards then load on the client from `/api/stock-market`. */
const TIMEOUT_MS = 8_000;

async function withTimeout<T>(promise: Promise<T>, ms = TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("stock data timeout")), ms); })]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Cards data for the homepage HTML. Null when the market read fails (cards then load on the client). A failed or
 * slow eligibility read only removes the Buy buttons (fail closed); the cards still render.
 */
export async function loadHomepageStocks(ms = TIMEOUT_MS): Promise<HomepageStocks | null> {
  const market = await withTimeout(loadStockMarket(), ms).catch(() => null);
  if (!market) return null;
  const eligibility = await withTimeout(loadStockBuyEligibility(market), ms).catch(() => null);
  return toHomepageStocks(market, eligibility);
}
