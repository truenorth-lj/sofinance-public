import type { WithdrawSummary } from "@sofinance/engine/withdraw/types";
import type { ToolName } from "./tool-definitions";
import {
  listPositions,
  quoteAddLiquidity,
  prepareTransaction,
  quoteCompound,
  prepareCompoundTransaction,
  submitSignedTransaction,
  submitCompoundTransaction,
  listRwaPairs,
  getPoolRangeApr,
  getPositionPerformance,
  getPositionRangeStatus,
  quoteOpenPosition,
  prepareOpenPosition,
  prepareWithdraw,
  submitWithdrawTransaction,
  submitOpenPosition,
  txStatus,
} from "./tools";
import {
  listPositionsSchema,
  quoteAddLiquiditySchema,
  prepareTransactionSchema,
  quoteCompoundSchema,
  submitSignedTransactionSchema,
  submitCompoundTransactionSchema,
  listRwaPairsSchema,
  getPoolRangeAprSchema,
  getPositionPerformanceSchema,
  getPositionRangeStatusSchema,
  quoteOpenPositionSchema,
  prepareOpenPositionSchema,
  prepareWithdrawSchema,
  submitWithdrawSchema,
  submitOpenPositionSchema,
  txStatusSchema,
} from "./schemas";

export type McpDispatchContext =
  | { surface: "mcp-http"; tokenWallet: string }
  /** Remote call with no (valid) bearer token: only `access: "public"` tools run. */
  | { surface: "mcp-http-public" }
  | { surface: "mcp-stdio" };

/**
 * `public`: read-only tools over saved snapshots that need no wallet and no token on the remote server.
 * `token` (default): everything else keeps the wallet-bound bearer token.
 */
export type ToolAccess = "public" | "token";
/** `position-read`: costly chain reads (account scans, signature history) with their own tighter per-IP limit. */
type ToolRateClass = "standard" | "position-read";

export const TOKEN_REQUIRED_MESSAGE = "Unauthorized: this tool needs a wallet-bound MCP token";

type WalletBinding<Input> =
  | { mode: "none" }
  | { mode: "required-match"; wallet: (input: Input) => string };

type ToolDefinition<Input, Output> = {
  access?: ToolAccess;
  rateClass?: ToolRateClass;
  parser: { parse(args: unknown): Input };
  missingArgs: "raw" | "empty-object";
  binding: WalletBinding<NoInfer<Input>>;
  handler: (input: NoInfer<Input>) => Output;
};

/** Keep the parser's concrete output inside the closure, including transforms/defaults. */
export function defineTool<Input, Output>(definition: ToolDefinition<Input, Output>) {
  const access: ToolAccess = definition.access ?? "token";
  const rateClass: ToolRateClass = definition.rateClass ?? "standard";
  const run = async (args: unknown, context: McpDispatchContext): Promise<Awaited<Output>> => {
    // Defence in depth: the route already answers 401 before reaching here for token tools.
    if (context.surface === "mcp-http-public" && access !== "public") throw new Error(TOKEN_REQUIRED_MESSAGE);
    const input = definition.parser.parse(definition.missingArgs === "empty-object" ? args ?? {} : args);
    const binding = definition.binding;
    if (context.surface === "mcp-http" && binding.mode !== "none") {
      const wallet = binding.wallet(input);
      if (wallet !== context.tokenWallet) {
        throw new Error(`Token wallet mismatch: token is for ${context.tokenWallet}, requested ${wallet}`);
      }
    }
    return await definition.handler(input);
  };
  return Object.assign(run, { access, rateClass });
}

const requiredWallet = { mode: "required-match", wallet: (input: { wallet: string }) => input.wallet } as const;
const noWallet = { mode: "none" } as const;
type ToolDispatch = ((args: unknown, context: McpDispatchContext) => Promise<unknown>) & { access: ToolAccess; rateClass: ToolRateClass };

// Each concrete schema/handler pair is checked before the closures share an execution signature.
export const TOOL_DISPATCH = {
  // Position reads are public (on-chain data, like the site's /api/portfolio): the wallet is a query parameter, not
  // an identity, so there is no binding; a token sent along is ignored (see the route).
  list_positions: defineTool({
    access: "public", rateClass: "position-read", parser: listPositionsSchema, missingArgs: "raw", binding: noWallet, handler: listPositions,
  }),
  quote_add_liquidity: defineTool({
    parser: quoteAddLiquiditySchema, missingArgs: "raw", binding: requiredWallet, handler: quoteAddLiquidity,
  }),
  prepare_transaction: defineTool({
    parser: prepareTransactionSchema, missingArgs: "raw", binding: requiredWallet, handler: prepareTransaction,
  }),
  quote_compound: defineTool({
    parser: quoteCompoundSchema, missingArgs: "raw", binding: requiredWallet, handler: quoteCompound,
  }),
  prepare_compound_transaction: defineTool({
    parser: quoteCompoundSchema, missingArgs: "raw", binding: requiredWallet, handler: prepareCompoundTransaction,
  }),
  submit_signed_transaction: defineTool({
    parser: submitSignedTransactionSchema, missingArgs: "raw", binding: requiredWallet, handler: submitSignedTransaction,
  }),
  submit_compound_transaction: defineTool({
    parser: submitCompoundTransactionSchema, missingArgs: "raw", binding: requiredWallet, handler: submitCompoundTransaction,
  }),
  quote_open_position: defineTool({
    parser: quoteOpenPositionSchema, missingArgs: "raw", binding: requiredWallet, handler: quoteOpenPosition,
  }),
  prepare_open_position: defineTool({
    parser: prepareOpenPositionSchema, missingArgs: "raw", binding: requiredWallet, handler: prepareOpenPosition,
  }),
  submit_open_position: defineTool({
    parser: submitOpenPositionSchema, missingArgs: "raw", binding: requiredWallet, handler: submitOpenPosition,
  }),
  prepare_withdraw: defineTool({
    parser: prepareWithdrawSchema, missingArgs: "raw", binding: requiredWallet, handler: prepareWithdraw,
  }),
  get_position_performance: defineTool({
    access: "public", rateClass: "position-read", parser: getPositionPerformanceSchema, missingArgs: "empty-object", binding: noWallet,
    handler: getPositionPerformance,
  }),
  get_position_range_status: defineTool({
    access: "public", rateClass: "position-read", parser: getPositionRangeStatusSchema, missingArgs: "empty-object", binding: noWallet,
    handler: getPositionRangeStatus,
  }),
  list_rwa_pairs: defineTool({
    access: "public", parser: listRwaPairsSchema, missingArgs: "empty-object", binding: noWallet, handler: listRwaPairs,
  }),
  get_pool_range_apr: defineTool({
    access: "public", parser: getPoolRangeAprSchema, missingArgs: "raw", binding: noWallet, handler: getPoolRangeApr,
  }),
  tx_status: defineTool({
    access: "public", parser: txStatusSchema, missingArgs: "raw", binding: noWallet, handler: txStatus,
  }),
  submit_withdraw: defineTool({
    parser: submitWithdrawSchema, missingArgs: "raw", binding: requiredWallet,
    handler: input => submitWithdrawTransaction({
      ...input,
      // The existing schema accepts a record, not a validated WithdrawSummary. Keep that
      // legacy boundary only here: the lazy sender verifies the permit before inspecting
      // summary fields. Strengthening this parser would change accepted input/error order.
      summary: input.summary as WithdrawSummary,
    }),
  }),
} satisfies Record<ToolName, ToolDispatch>;

function isToolName(name: string): name is ToolName {
  return Object.hasOwn(TOOL_DISPATCH, name);
}

/** Rate class of a known tool; unknown names are `standard` (they fail fast in dispatch). */
export function toolRateClass(name: string): ToolRateClass {
  return isToolName(name) ? TOOL_DISPATCH[name].rateClass : "standard";
}

/** True only for a known tool whose dispatch entry is `access: "public"`. */
export function isPublicTool(name: string): boolean {
  return isToolName(name) && TOOL_DISPATCH[name].access === "public";
}

export async function dispatchTool(name: string, args: unknown, context: McpDispatchContext): Promise<unknown> {
  if (!isToolName(name)) throw new Error(`Unknown tool: ${name}`);
  return TOOL_DISPATCH[name](args, context);
}
