import "@/lib/engine-host";
import "server-only";
import { searchSelectedQuoteBundle } from "@/lib/selected-quote";
import type { QuoteAdd } from "../selected-read";

/** Full native quote, distinct from the generic adapter's minimum-deposit check. */
export const quoteRaydiumAdd: QuoteAdd = async (command, context) => {
  const { wallet, selection, amount, floorBps, toleranceBps } = command;
  const { quote } = await searchSelectedQuoteBundle(wallet, selection, amount, floorBps, toleranceBps,
    { buildTransactions: false, includeResale: false,
      ...(context ? { signal: context.signal, budget: context.budget, connection: context.connection } : {}) });
  return quote;
};
