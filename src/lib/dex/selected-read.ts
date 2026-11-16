/** Read-only compatibility contracts for existing App and MCP selected-position transports. */
import type { Connection } from "@solana/web3.js";
import type { JupiterRetryBudget } from "@sofinance/engine/jupiter/client";
import type { PositionSelection, SelectedPositionState } from "@sofinance/engine/selected-types";
import type { SelectedQuote } from "@/lib/selected-quote-types";
import type { AddPrepareCommand } from "./add-prepare";
export type AddReadCommand = { wallet: string; selection: PositionSelection };
export type AddQuoteContext = { signal: AbortSignal; budget: JupiterRetryBudget; connection: Connection };
export type QuoteAdd = (command: AddPrepareCommand, context?: AddQuoteContext) => Promise<SelectedQuote>;
export type ReadAddState = (command: AddReadCommand) => Promise<SelectedPositionState>;
