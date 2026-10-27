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
  getPositionPerformance,
  getPoolActivity,
  getPositionRangeStatus,
  quoteOpenPosition,
  prepareOpenPosition,
  prepareWithdraw,
  submitWithdrawTransaction,
  submitOpenPosition,
} from "./tools";
import {
  listPositionsSchema,
  quoteAddLiquiditySchema,
  prepareTransactionSchema,
  quoteCompoundSchema,
  submitSignedTransactionSchema,
  submitCompoundTransactionSchema,
  listRwaPairsSchema,
  getPositionPerformanceSchema,
  getPoolActivitySchema,
  getPositionRangeStatusSchema,
  quoteOpenPositionSchema,
  prepareOpenPositionSchema,
  prepareWithdrawSchema,
  submitWithdrawSchema,
  submitOpenPositionSchema,
} from "./schemas";

export type McpDispatchContext =
  | { surface: "mcp-http"; tokenWallet: string }
  | { surface: "mcp-stdio" };

type WalletBinding<Input> =
  | { mode: "none" }
  | { mode: "required-match"; wallet: (input: Input) => string }
  | { mode: "optional-match"; wallet: (input: Input) => string | undefined };

type ToolDefinition<Input, Output> = {
  parser: { parse(args: unknown): Input };
  missingArgs: "raw" | "empty-object";
  binding: WalletBinding<NoInfer<Input>>;
  handler: (input: NoInfer<Input>) => Output;
};

/** Keep the parser's concrete output inside the closure, including transforms/defaults. */
export function defineTool<Input, Output>(definition: ToolDefinition<Input, Output>) {
  return async (args: unknown, context: McpDispatchContext): Promise<Awaited<Output>> => {
    const input = definition.parser.parse(definition.missingArgs === "empty-object" ? args ?? {} : args);
    const binding = definition.binding;
    if (context.surface === "mcp-http" && binding.mode !== "none") {
      const wallet = binding.wallet(input);
      if ((binding.mode === "required-match" || wallet !== undefined) && wallet !== context.tokenWallet) {
        throw new Error(`Token wallet mismatch: token is for ${context.tokenWallet}, requested ${wallet}`);
      }
    }
    return await definition.handler(input);
  };
}

const requiredWallet = { mode: "required-match", wallet: (input: { wallet: string }) => input.wallet } as const;
const optionalWallet = { mode: "optional-match", wallet: (input: { wallet?: string }) => input.wallet } as const;
const noWallet = { mode: "none" } as const;
type ToolDispatch = (args: unknown, context: McpDispatchContext) => Promise<unknown>;

// Each concrete schema/handler pair is checked before the closures share an execution signature.
export const TOOL_DISPATCH = {
  list_positions: defineTool({
    parser: listPositionsSchema, missingArgs: "raw", binding: requiredWallet, handler: listPositions,
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
    parser: getPositionPerformanceSchema, missingArgs: "empty-object", binding: optionalWallet, handler: getPositionPerformance,
  }),
  get_position_range_status: defineTool({
    parser: getPositionRangeStatusSchema, missingArgs: "empty-object", binding: optionalWallet, handler: getPositionRangeStatus,
  }),
  get_pool_activity: defineTool({
    parser: getPoolActivitySchema, missingArgs: "empty-object", binding: noWallet, handler: getPoolActivity,
  }),
  list_rwa_pairs: defineTool({
    parser: listRwaPairsSchema, missingArgs: "empty-object", binding: noWallet, handler: listRwaPairs,
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

export async function dispatchTool(name: string, args: unknown, context: McpDispatchContext): Promise<unknown> {
  if (!isToolName(name)) throw new Error(`Unknown tool: ${name}`);
  return TOOL_DISPATCH[name](args, context);
}
