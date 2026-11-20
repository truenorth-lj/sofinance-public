import "@/lib/engine-host";
import "server-only";
import { getOpenPositionQuoteBundle } from "@sofinance/engine/open-quote";
import { JUPITER_MAX_ACCOUNTS } from "@sofinance/engine/jupiter-route-retry";
import { cachedOpenPoolState } from "@/lib/open-pool-snapshot";
import { rangeWithFairCenter } from "@/lib/open-range-center";
import { APP_OPEN_QUOTE, type QuoteOpen } from "../open-prepare";

export const quoteRaydiumOpen: QuoteOpen = async (command, profile) => {
  const { wallet, selection, amount, floorBps, toleranceBps } = command;
  const snapshot = await cachedOpenPoolState(wallet, selection);
  const range = rangeWithFairCenter(command.range, snapshot);
  // App preview preserves its relay-round cache and prepare's first route budget.
  // MCP keeps its complete quote/build and original engine defaults.
  const result = profile === APP_OPEN_QUOTE
    ? await getOpenPositionQuoteBundle(wallet, selection, amount, range, floorBps, toleranceBps,
      { maxAccounts: JUPITER_MAX_ACCOUNTS.wide }, snapshot, "parallel", { build: false })
    : await getOpenPositionQuoteBundle(wallet, selection, amount, range, floorBps, toleranceBps, undefined, snapshot);
  return result.quote;
};
