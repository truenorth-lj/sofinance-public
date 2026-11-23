/**
 * Tools the HTTP endpoint lists, in tools/list order (the stdio server lists the same set). Kept apart from
 * tool-definitions.ts so client pages (/app/ai, the MCP connection card) can show the names and count without
 * bundling every description (tool-definitions.ts must stay free of runtime imports). tool-names.test.ts keeps
 * this list equal to tools/list.
 */
export const HTTP_TOOL_NAMES = ["lp_withdraw_prepare", "lp_withdraw_submit", "position_get_performance", "position_get_range_status", "pools_list", "pool_get_range_apr", "positions_list", "lp_add_quote", "lp_add_prepare", "lp_compound_quote", "lp_compound_prepare", "lp_add_submit", "lp_compound_submit", "lp_open_quote", "lp_open_prepare", "lp_open_submit", "tx_status"] as const;

export const MCP_TOOL_COUNT = HTTP_TOOL_NAMES.length;
