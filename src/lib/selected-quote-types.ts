/** Compile-time quote DTO; the builder remains the single source of its field types. */
import type { getSelectedQuoteBundle } from "./selected-quote";
export type SelectedQuote = Awaited<ReturnType<typeof getSelectedQuoteBundle>>["quote"];
