import "@/lib/engine-host";
import "server-only";
import { getOpenPositionQuoteBundle } from "@sofinance/engine/open-quote";
import { JUPITER_MAX_ACCOUNTS } from "@sofinance/engine/jupiter-route-retry";
import { cachedOpenPoolState } from "@/lib/open-pool-snapshot";
import { APP_OPEN_QUOTE, type QuoteOpen } from "../open-prepare";

export const quoteRaydiumOpen: QuoteOpen = async (command, profile) => {
  const { wallet, selection, amount, range, floorBps, toleranceBps } = command;
  // App preview preserves its relay-round cache and prepare's first route budget.
  // MCP keeps its complete quote/build and original engine defaults.
  // Fair centering is applied once, inside getOpenPositionQuoteBundle, after the on-chain snapshot is read.
  if (profile === APP_OPEN_QUOTE) {
    const snapshot = await cachedOpenPoolState(wallet, selection);
    const result = await getOpenPositionQuoteBundle(
      wallet, selection, amount, range, floorBps, toleranceBps,
      { maxAccounts: JUPITER_MAX_ACCOUNTS.wide }, snapshot, "parallel", { build: false },
    );
    return result.quote;
  }
  const result = await getOpenPositionQuoteBundle(wallet, selection, amount, range, floorBps, toleranceBps);
  return result.quote;
};
