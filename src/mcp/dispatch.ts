import type { WithdrawSummary } from "@sofinance/engine/withdraw/types";
import { TOOL_ALIASES, type ToolName } from "./tool-definitions";
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
  positions_list: defineTool({
    access: "public", rateClass: "position-read", parser: listPositionsSchema, missingArgs: "raw", binding: noWallet, handler: listPositions,
  }),
  lp_add_quote: defineTool({
    parser: quoteAddLiquiditySchema, missingArgs: "raw", binding: requiredWallet, handler: quoteAddLiquidity,
  }),
  lp_add_prepare: defineTool({
    parser: prepareTransactionSchema, missingArgs: "raw", binding: requiredWallet, handler: prepareTransaction,
  }),
  lp_compound_quote: defineTool({
    parser: quoteCompoundSchema, missingArgs: "raw", binding: requiredWallet, handler: quoteCompound,
  }),
  lp_compound_prepare: defineTool({
    parser: quoteCompoundSchema, missingArgs: "raw", binding: requiredWallet, handler: prepareCompoundTransaction,
  }),
  lp_add_submit: defineTool({
    parser: submitSignedTransactionSchema, missingArgs: "raw", binding: requiredWallet, handler: submitSignedTransaction,
  }),
  lp_compound_submit: defineTool({
    parser: submitCompoundTransactionSchema, missingArgs: "raw", binding: requiredWallet, handler: submitCompoundTransaction,
  }),
  lp_open_quote: defineTool({
    parser: quoteOpenPositionSchema, missingArgs: "raw", binding: requiredWallet, handler: quoteOpenPosition,
  }),
  lp_open_prepare: defineTool({
    parser: prepareOpenPositionSchema, missingArgs: "raw", binding: requiredWallet, handler: prepareOpenPosition,
  }),
  lp_open_submit: defineTool({
    parser: submitOpenPositionSchema, missingArgs: "raw", binding: requiredWallet, handler: submitOpenPosition,
  }),
  lp_withdraw_prepare: defineTool({
    parser: prepareWithdrawSchema, missingArgs: "raw", binding: requiredWallet, handler: prepareWithdraw,
  }),
  position_get_performance: defineTool({
    access: "public", rateClass: "position-read", parser: getPositionPerformanceSchema, missingArgs: "empty-object", binding: noWallet,
    handler: getPositionPerformance,
  }),
  position_get_range_status: defineTool({
    access: "public", rateClass: "position-read", parser: getPositionRangeStatusSchema, missingArgs: "empty-object", binding: noWallet,
    handler: getPositionRangeStatus,
  }),
  pools_list: defineTool({
    access: "public", parser: listRwaPairsSchema, missingArgs: "empty-object", binding: noWallet, handler: listRwaPairs,
  }),
  pool_get_range_apr: defineTool({
    access: "public", parser: getPoolRangeAprSchema, missingArgs: "raw", binding: noWallet, handler: getPoolRangeApr,
  }),
  tx_status: defineTool({
    access: "public", parser: txStatusSchema, missingArgs: "raw", binding: noWallet, handler: txStatus,
  }),
  lp_withdraw_submit: defineTool({
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

/** The tool a called name runs: itself, or the new tool for a hidden pre-0.3 alias. Null for an unknown name. */
function canonicalTool(name: string): ToolName | null {
  if (isToolName(name)) return name;
  return Object.hasOwn(TOOL_ALIASES, name) ? TOOL_ALIASES[name as keyof typeof TOOL_ALIASES] : null;
}

/** Rate class of a known tool; unknown names are `standard` (they fail fast in dispatch). */
export function toolRateClass(name: string): ToolRateClass {
  const tool = canonicalTool(name);
  return tool ? TOOL_DISPATCH[tool].rateClass : "standard";
}

/** Canonical tool for a called name; `aliasUsed` when it was a hidden pre-0.3 alias. Unknown names are null. */
export function resolveToolName(name: string): { tool: ToolName; aliasUsed: boolean } | null {
  const tool = canonicalTool(name);
  return tool ? { tool, aliasUsed: tool !== name } : null;
}

/** True only for a known tool (or its alias) whose dispatch entry is `access: "public"`. */
export function isPublicTool(name: string): boolean {
  const tool = canonicalTool(name);
  return tool !== null && TOOL_DISPATCH[tool].access === "public";
}

export async function dispatchTool(name: string, args: unknown, context: McpDispatchContext): Promise<unknown> {
  const tool = canonicalTool(name);
  if (!tool) throw new Error(`Unknown tool: ${name}`);
  return TOOL_DISPATCH[tool](args, context);
}
